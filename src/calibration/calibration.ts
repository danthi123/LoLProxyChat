interface PlayerInfo {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
}

interface CircleState {
  el: HTMLElement;
  player: PlayerInfo;
  x: number;
  y: number;
}

const toolbarEl = document.getElementById('toolbar')!;
const canvasArea = document.getElementById('canvas-area')!;
const btnCapture = document.getElementById('btn-capture')!;
const btnClose = document.getElementById('btn-close')!;
const statusEl = document.getElementById('status')!;
const captureCountEl = document.getElementById('capture-count')!;

let circles: CircleState[] = [];
let captureCount = 0;
let dragTarget: CircleState | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

// --- Toolbar dragging (moves window) ---
let toolbarDragging = false;
let toolbarDragX = 0;
let toolbarDragY = 0;

toolbarEl.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).tagName === 'BUTTON') return;
  toolbarDragging = true;
  toolbarDragX = e.clientX;
  toolbarDragY = e.clientY;
  toolbarEl.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (toolbarDragging) {
    const dx = e.clientX - toolbarDragX;
    const dy = e.clientY - toolbarDragY;
    toolbarDragX = e.clientX;
    toolbarDragY = e.clientY;
    overwolf.windows.getCurrentWindow((result: any) => {
      if (result.success) {
        const win = result.window;
        overwolf.windows.changePosition(win.id, win.left + dx, win.top + dy, () => {});
      }
    });
    return;
  }

  if (!dragTarget) return;
  const rect = canvasArea.getBoundingClientRect();
  dragTarget.x = Math.max(0, Math.min(rect.width - 24, e.clientX - rect.left - dragOffsetX));
  dragTarget.y = Math.max(0, Math.min(rect.height - 24, e.clientY - rect.top - dragOffsetY));
  dragTarget.el.style.left = dragTarget.x + 'px';
  dragTarget.el.style.top = dragTarget.y + 'px';
});

function endDrag() {
  if (toolbarDragging) {
    toolbarDragging = false;
    toolbarEl.style.cursor = 'grab';
  }
  if (dragTarget) {
    dragTarget.el.classList.remove('dragging');
    dragTarget = null;
  }
}

document.addEventListener('mouseup', endDrag);
// Also end drag if cursor leaves the window (common with Overwolf overlays)
document.addEventListener('mouseleave', endDrag);

// --- Create circle for a player ---
function createCircle(player: PlayerInfo, index: number): CircleState {
  const el = document.createElement('div');
  el.className = 'champion-circle ' + (player.team === 'ORDER' ? 'blue' : 'red');
  // Show short champion name (first 4 chars)
  el.textContent = player.championName.substring(0, 4);
  el.title = player.championName + ' (' + player.summonerName + ')';

  // Stagger initial positions vertically
  const startX = 50;
  const startY = 30 + index * 35;

  el.style.left = startX + 'px';
  el.style.top = startY + 'px';

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const state = circles.find((c) => c.el === el);
    if (!state) return;
    dragTarget = state;
    dragOffsetX = e.clientX - el.getBoundingClientRect().left;
    dragOffsetY = e.clientY - el.getBoundingClientRect().top;
    el.classList.add('dragging');
  });

  canvasArea.appendChild(el);

  return { el, player, x: startX, y: startY };
}

// --- Capture button ---
btnCapture.addEventListener('click', () => {
  // Collect circle positions relative to the canvas area
  const rect = canvasArea.getBoundingClientRect();
  const positions = circles.map((c) => ({
    summonerName: c.player.summonerName,
    championName: c.player.championName,
    team: c.player.team,
    // Center of circle (circle is 24px)
    pixelX: Math.round(c.x + 12),
    pixelY: Math.round(c.y + 12),
    // Relative position (0-1) within the canvas area
    relX: (c.x + 12) / rect.width,
    relY: (c.y + 12) / rect.height,
  }));

  // Get window position for computing absolute screen coordinates
  overwolf.windows.getCurrentWindow((winResult: any) => {
    if (!winResult.success) return;
    const win = winResult.window;
    const windowLeft = win.left;
    const windowTop = win.top;
    const toolbarHeight = 28;

    const absolutePositions = positions.map((p) => ({
      ...p,
      screenX: windowLeft + p.pixelX,
      screenY: windowTop + toolbarHeight + p.pixelY,
    }));

    // Send to background for screenshot + save
    overwolf.windows.sendMessage('background', 'calibrationCapture', {
      positions: absolutePositions,
      windowBounds: {
        left: windowLeft,
        top: windowTop + toolbarHeight,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    }, () => {});

    captureCount++;
    captureCountEl.textContent = captureCount + ' saved';
    btnCapture.textContent = 'CAPTURED!';
    setTimeout(() => { btnCapture.textContent = 'CAPTURE'; }, 500);
  });
});

// --- Close button ---
btnClose.addEventListener('click', () => {
  overwolf.windows.getCurrentWindow((result: any) => {
    if (result.success) {
      overwolf.windows.close(result.window.id, () => {});
    }
  });
});

// --- Receive player list from background ---
overwolf.windows.onMessageReceived.addListener((message: any) => {
  if (message.id === 'calibrationPlayers') {
    const players: PlayerInfo[] = message.content.players;
    statusEl.textContent = 'Place circles over champions (' + players.length + ' players)';

    // Clear existing circles
    circles.forEach((c) => c.el.remove());
    circles = [];

    // Create circles for each player
    players.forEach((player, i) => {
      circles.push(createCircle(player, i));
    });
  }
});

// Request player list
overwolf.windows.sendMessage('background', 'calibrationReady', {}, () => {});

console.log('ProxChat calibration window loaded');

export {};
