interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  trackingState?: string;
  lastPosition?: { x: number; y: number } | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnDebug = document.getElementById('btn-debug')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;
const trackingDot = document.getElementById('tracking-dot')!;
const minimapBorder = document.getElementById('minimap-border')!;

// Map dimensions for Summoner's Rift (for tracking dot position)
const MAP_WIDTH = 14820;
const MAP_HEIGHT = 14881;

// Debug overlay state (off by default)
let debugEnabled = false;

// Per-player volume cache (so sliders don't reset on re-render)
const playerVolumes: Map<string, number> = new Map();

// --- Window info cache ---
let cachedWinId = '';
let cachedWinLeft = 0;
let cachedWinTop = 0;
let cachedWinWidth = 0;
let cachedWinHeight = 0;
const PANEL_WIDTH = 240;

overwolf.windows.getCurrentWindow((result: any) => {
  if (result.success) {
    cachedWinId = result.window.id;
    cachedWinLeft = result.window.left;
    cachedWinTop = result.window.top;
    cachedWinWidth = result.window.width;
    cachedWinHeight = result.window.height;
  }
});

// --- Refresh cached position/size from Overwolf ---
function refreshWindowInfo(): void {
  if (!cachedWinId) return;
  overwolf.windows.getCurrentWindow((result: any) => {
    if (result.success) {
      cachedWinLeft = result.window.left;
      cachedWinTop = result.window.top;
      cachedWinWidth = result.window.width;
      cachedWinHeight = result.window.height;
    }
  });
}

// --- Dragging (move window via header) ---
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  dragHandle.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging || !cachedWinId) return;
  const dx = e.screenX - dragStartX;
  const dy = e.screenY - dragStartY;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  cachedWinLeft += dx;
  cachedWinTop += dy;
  overwolf.windows.changePosition(cachedWinId, cachedWinLeft, cachedWinTop, () => {});
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    dragHandle.style.cursor = 'grab';
  }
});

// --- Resize handles (use Overwolf native dragResize) ---
const resizeMap: Record<string, string> = {
  'corner-tr': 'TopRight',
  'corner-br': 'BottomRight',
  'edge-top': 'Top',
  'edge-right': 'Right',
  'edge-bottom': 'Bottom',
};

for (const [id, edge] of Object.entries(resizeMap)) {
  document.getElementById(id)!.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (cachedWinId) {
      overwolf.windows.dragResize(cachedWinId, edge as any);
    }
  });
}

// After a resize ends, refresh window info to get new size
for (const id of Object.keys(resizeMap)) {
  document.getElementById(id)!.addEventListener('mouseup', () => {
    setTimeout(refreshWindowInfo, 100);
    setTimeout(refreshWindowInfo, 300);
  });
}

// Also listen for window size changes via a periodic check during resize
let resizeCheckInterval: number | null = null;
document.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('corner') || target.classList.contains('edge')) {
    resizeCheckInterval = window.setInterval(refreshWindowInfo, 200);
  }
});
document.addEventListener('mouseup', () => {
  if (resizeCheckInterval) {
    clearInterval(resizeCheckInterval);
    resizeCheckInterval = null;
    setTimeout(refreshWindowInfo, 100);
  }
});

// --- Controls ---
btnSelfMute.addEventListener('click', () => {
  const nowMuted = !btnSelfMute.classList.contains('active');
  btnSelfMute.classList.toggle('active', nowMuted);
  btnSelfMute.textContent = nowMuted ? 'MIC OFF' : 'MIC';
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  const nowMuted = !btnMuteAll.classList.contains('active');
  btnMuteAll.classList.toggle('active', nowMuted);
  btnMuteAll.textContent = nowMuted ? 'ALL OFF' : 'VOL';
  sendToBackground('toggleMuteAll', {});
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  btnDebug.textContent = debugEnabled ? 'ON' : 'OFF';
  btnDebug.classList.toggle('active', debugEnabled);
  // Immediately hide debug elements when toggled off
  if (!debugEnabled) {
    trackingDot.style.display = 'none';
    minimapBorder.style.backgroundImage = '';
    minimapBorder.style.boxShadow = '';
  } else {
    minimapBorder.style.boxShadow = 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)';
  }
});

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

document.getElementById('input-volume')!.addEventListener('input', (e) => {
  const vol = parseInt((e.target as HTMLInputElement).value) / 100;
  sendToBackground('updateSettings', { inputVolume: vol });
});

const scanRateInput = document.getElementById('input-scan-rate') as HTMLInputElement;
const scanRateLabel = document.getElementById('scan-rate-label')!;
scanRateInput.addEventListener('input', () => {
  const fps = parseInt(scanRateInput.value);
  scanRateLabel.textContent = String(fps);
  sendToBackground('setScanRate', { fps });
});

function sendToBackground(action: string, payload: any): void {
  overwolf.windows.sendMessage('background', action, payload, () => {});
}

// --- Build player row using safe DOM methods ---
function createPlayerRow(peer: NearbyPeer): HTMLElement {
  const row = document.createElement('div');
  row.className = 'player-row ' + (peer.team === 'ORDER' ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  row.appendChild(nameSpan);

  if (peer.isDead) {
    const deadIndicator = document.createElement('span');
    deadIndicator.className = 'player-muted-indicator';
    deadIndicator.textContent = 'DEAD';
    row.appendChild(deadIndicator);
  } else if (peer.isMuted) {
    const mutedIndicator = document.createElement('span');
    mutedIndicator.className = 'player-muted-indicator';
    mutedIndicator.textContent = 'MUTED';
    row.appendChild(mutedIndicator);
  }

  // Per-player volume slider
  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.className = 'player-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
  volSlider.addEventListener('input', () => {
    const vol = parseInt(volSlider.value) / 100;
    playerVolumes.set(peer.summonerName, vol);
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  // Per-player mute toggle button
  const muteBtn = document.createElement('button');
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  return row;
}

// --- Render state ---
function renderState(state: OverlayState): void {
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnSelfMute.textContent = state.selfMuted ? 'MIC OFF' : 'MIC';
  btnMuteAll.classList.toggle('active', state.muteAll);
  btnMuteAll.textContent = state.muteAll ? 'ALL OFF' : 'VOL';

  while (playerList.firstChild) {
    playerList.removeChild(playerList.firstChild);
  }

  if (state.nearbyPeers.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'Waiting for nearby players...';
    playerList.appendChild(emptyDiv);
  }

  if (state.nearbyPeers.length > 0) {
    for (const peer of state.nearbyPeers) {
      playerList.appendChild(createPlayerRow(peer));
    }
  }

  // Debug info: tracking state + position (only when debug enabled)
  if (debugEnabled && (state.trackingState || state.lastPosition)) {
    const dbg = document.createElement('div');
    dbg.className = 'empty-state';
    dbg.style.fontSize = '10px';
    const parts: string[] = [];
    if (state.trackingState) parts.push('tracking: ' + state.trackingState);
    if (state.lastPosition) {
      parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
    }
    dbg.textContent = parts.join(' | ');
    playerList.appendChild(dbg);
  }

  // Update tracking dot position on minimap border (only when debug enabled)
  if (debugEnabled && state.lastPosition && state.lastPosition.x > 0 && state.lastPosition.y > 0) {
    const relX = state.lastPosition.x / MAP_WIDTH;
    const relY = 1 - state.lastPosition.y / MAP_HEIGHT;
    trackingDot.style.left = (relX * 100) + '%';
    trackingDot.style.top = (relY * 100) + '%';
    trackingDot.style.display = 'block';
  } else {
    trackingDot.style.display = 'none';
  }

  // Update filtered debug image on minimap border (only when debug enabled)
  if (debugEnabled && state.filteredImageUrl) {
    minimapBorder.style.backgroundImage = 'url(' + state.filteredImageUrl + ')';
    minimapBorder.style.backgroundSize = '100% 100%';
    minimapBorder.style.backgroundRepeat = 'no-repeat';
  } else if (!debugEnabled) {
    minimapBorder.style.backgroundImage = '';
  }
}

// --- Listen for state updates from background ---
overwolf.windows.onMessageReceived.addListener((message: any) => {
  if (message.id === 'overlayUpdate') {
    renderState(message.content);
  }
});

console.log('LoLProxChat overlay loaded');

export {};
