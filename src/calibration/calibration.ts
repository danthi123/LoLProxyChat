declare const overwolf: any;

const btnConfirm = document.getElementById('btn-confirm')!;
const btnClose = document.getElementById('btn-close')!;

let winId = '';

// Cache window ID on load
overwolf.windows.getCurrentWindow((result: any) => {
  if (result.success) {
    winId = result.window.id;
  }
});

// --- Corner resize handles ---
const resizeMap: Record<string, string> = {
  'corner-tl': 'TopLeft',
  'corner-tr': 'TopRight',
  'corner-bl': 'BottomLeft',
  'corner-br': 'BottomRight',
};

for (const [id, edge] of Object.entries(resizeMap)) {
  document.getElementById(id)!.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (winId) {
      overwolf.windows.dragResize(winId, edge);
    }
  });
}

// --- Edge drag handles (move window) ---
const edges = ['edge-top', 'edge-bottom', 'edge-left', 'edge-right'];
for (const id of edges) {
  document.getElementById(id)!.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (winId) {
      overwolf.windows.dragMove(winId);
    }
  });
}

// --- Confirm: send window bounds to background as minimap region ---
btnConfirm.addEventListener('click', () => {
  overwolf.windows.getCurrentWindow((result: any) => {
    if (!result.success) return;
    const win = result.window;

    const bounds = {
      screenX: win.left,
      screenY: win.top,
      screenWidth: win.width,
      screenHeight: win.height,
    };

    console.log('[Calibration] Confirmed bounds:', JSON.stringify(bounds));

    // Save to localStorage for persistence
    localStorage.setItem('proxchat_minimap_bounds', JSON.stringify(bounds));

    // Send to background
    overwolf.windows.sendMessage('background', 'calibrationBounds', bounds, () => {});

    btnConfirm.textContent = 'SAVED';
    btnConfirm.classList.add('saved');
    setTimeout(() => {
      btnConfirm.textContent = 'OK';
      btnConfirm.classList.remove('saved');
    }, 1500);
  });
});

// --- Close ---
btnClose.addEventListener('click', () => {
  if (winId) {
    overwolf.windows.close(winId, () => {});
  }
});

console.log('ProxChat calibration window loaded');

export {};
