import { Orchestrator } from '../services/orchestrator';

// DEBUG: pipe console to file for troubleshooting
// Buffer log lines and flush every 3 seconds to avoid overwrites
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

let logBuffer: string[] = [];
let flushTimer: number | null = null;

function flushLogs() {
  if (logBuffer.length === 0) return;
  const chunk = logBuffer.join('');
  logBuffer = [];
  // Read existing file, append new lines, write back
  const storageSpace = (overwolf as any).extensions.io.enums.StorageSpace.appData;
  (overwolf as any).extensions.io.readTextFile(storageSpace, 'proxchat-debug.log', (readResult: any) => {
    const existing = (readResult?.success || readResult?.status === 'success') ? (readResult.content || '') : '';
    // Keep only last 200KB to prevent unbounded growth
    const maxSize = 200000;
    let combined = existing + chunk;
    if (combined.length > maxSize) {
      combined = combined.slice(combined.length - maxSize);
    }
    (overwolf as any).extensions.io.writeTextFile(storageSpace, 'proxchat-debug.log', combined, () => {});
  });
}

function debugToFile(msg: string) {
  const ts = new Date().toISOString();
  logBuffer.push(ts + ' ' + msg + '\n');
  if (!flushTimer) {
    flushTimer = window.setInterval(flushLogs, 3000) as unknown as number;
  }
}

console.log = (...args: any[]) => { origLog(...args); debugToFile(args.map(String).join(' ')); };
console.warn = (...args: any[]) => { origWarn(...args); debugToFile('[WARN] ' + args.map(String).join(' ')); };
console.error = (...args: any[]) => { origError(...args); debugToFile('[ERR] ' + args.map(String).join(' ')); };

// Clear previous log file on startup
(overwolf as any).extensions.io.writeTextFile(
  (overwolf as any).extensions.io.enums.StorageSpace.appData,
  'proxchat-debug.log',
  '=== ProxChat Debug Log ===\n',
  () => {}
);

console.log('[ProxChat] Background script loading...');

// DEBUG: Open overlay immediately for testing
overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
  console.log('[ProxChat] obtainDeclaredWindow overlay:', JSON.stringify(result));
  if (result.success) {
    overwolf.windows.restore(result.window.id, (restoreResult: any) => {
      console.log('[ProxChat] overlay restore result:', JSON.stringify(restoreResult));
    });
  }
});

const orchestrator = new Orchestrator();
orchestrator.start();

console.log('[ProxChat] Orchestrator started');

// Listen for messages from overlay window
// sendMessage uses (windowId, messageId, messageContent) → received as { id, content }
overwolf.windows.onMessageReceived.addListener((message: any) => {
  const action = message.id;
  const payload = message.content || {};
  console.log('[ProxChat] Received message from overlay:', action);
  switch (action) {
    case 'toggleSelfMute':
      orchestrator.toggleSelfMute();
      break;
    case 'toggleMuteAll':
      orchestrator.toggleMuteAll();
      break;
    case 'toggleMutePlayer':
      orchestrator.toggleMutePlayer(payload.name);
      break;
    case 'setPlayerVolume':
      orchestrator.setPlayerVolume(payload.name, payload.volume);
      break;
    case 'setScanRate':
      orchestrator.setScanRate(payload.fps);
      break;
    case 'setPTT':
      orchestrator.setPTTState(payload.held);
      break;
    case 'updateSettings':
      orchestrator.updateSettings(payload);
      break;
    case 'calibrationBounds':
      orchestrator.setMinimapCalibration(payload);
      break;
  }
});

// PTT hotkey (hold)
overwolf.settings.hotkeys.onHold.addListener((event: any) => {
  if (event.name === 'push_to_talk') {
    orchestrator.setPTTState(event.state === 'down');
  }
});

// Toggle mute hotkey
overwolf.settings.hotkeys.onPressed.addListener((event: any) => {
  if (event.name === 'toggle_mute') {
    orchestrator.toggleSelfMute();
  }
});

console.log('LoLProxChat background service started');
