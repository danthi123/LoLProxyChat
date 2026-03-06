import { calculateVolume } from '../core/proximity';

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  distance: number;
  isMuted: boolean;
  isMutedByLocal: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
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
      const win = result.window;
      overwolf.windows.changePosition(win.id, win.left + dx, win.top + dy, () => {});
    }
  });
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  dragHandle.style.cursor = 'grab';
});

// --- Controls ---
btnSelfMute.addEventListener('click', () => {
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  sendToBackground('toggleMuteAll', {});
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
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
  const vol = calculateVolume(peer.distance);
  const volPct = Math.round(vol * 100);

  const row = document.createElement('div');
  row.className = 'player-row ' + (peer.team === 'ORDER' ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName; // textContent is XSS-safe
  row.appendChild(nameSpan);

  if (peer.isMuted) {
    const mutedIndicator = document.createElement('span');
    mutedIndicator.className = 'player-muted-indicator';
    mutedIndicator.textContent = 'MUTED';
    row.appendChild(mutedIndicator);
  }

  const volumeBar = document.createElement('div');
  volumeBar.className = 'player-volume-bar';
  const volumeFill = document.createElement('div');
  volumeFill.className = 'player-volume-fill';
  volumeFill.style.width = volPct + '%';
  volumeBar.appendChild(volumeFill);
  row.appendChild(volumeBar);

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

  const sorted = [...state.nearbyPeers].sort((a, b) => a.distance - b.distance);
  for (const peer of sorted) {
    playerList.appendChild(createPlayerRow(peer));
  }
}

// --- Listen for state updates from background ---
overwolf.windows.onMessageReceived.addListener((message: any) => {
  if (message.id === 'overlayUpdate') {
    renderState(message.content);
  }
});

console.log('LoLProxChat overlay loaded');
