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
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;

// --- Dragging ---
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragOffsetX = e.clientX;
  dragOffsetY = e.clientY;
  dragHandle.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - dragOffsetX;
  const dy = e.clientY - dragOffsetY;
  dragOffsetX = e.clientX;
  dragOffsetY = e.clientY;
  overwolf.windows.getCurrentWindow((result: any) => {
    if (result.success) {
      overwolf.windows.changePosition(result.window.id,
        result.window.left + dx, result.window.top + dy, () => {});
    }
  });
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  dragHandle.style.cursor = 'grab';
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

document.getElementById('btn-calibrate')!.addEventListener('click', () => {
  sendToBackground('openCalibration', {});
});

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

document.getElementById('input-volume')!.addEventListener('input', (e) => {
  const vol = parseInt((e.target as HTMLInputElement).value) / 100;
  sendToBackground('updateSettings', { inputVolume: vol });
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
  nameSpan.textContent = peer.championName; // textContent is XSS-safe
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
  // Update header buttons
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnSelfMute.textContent = state.selfMuted ? 'MIC OFF' : 'MIC';
  btnMuteAll.classList.toggle('active', state.muteAll);
  btnMuteAll.textContent = state.muteAll ? 'ALL OFF' : 'VOL';

  // Clear player list safely
  while (playerList.firstChild) {
    playerList.removeChild(playerList.firstChild);
  }

  if (state.nearbyPeers.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'Waiting for nearby players...';
    playerList.appendChild(emptyDiv);
    return;
  }

  for (const peer of state.nearbyPeers) {
    playerList.appendChild(createPlayerRow(peer));
  }

  // Debug: show tracking state and position
  if (state.trackingState || state.lastPosition) {
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
}

// --- Listen for state updates from background ---
overwolf.windows.onMessageReceived.addListener((message: any) => {
  if (message.id === 'overlayUpdate') {
    renderState(message.content);
  }
});

console.log('LoLProxChat overlay loaded');
