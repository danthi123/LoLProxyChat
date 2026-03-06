import { Orchestrator } from '../services/orchestrator';

const orchestrator = new Orchestrator();
orchestrator.start();

// Listen for messages from overlay window
overwolf.windows.onMessageReceived.addListener((message: any) => {
  const { action, payload } = message;
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
    case 'setPTT':
      orchestrator.setPTTState(payload.held);
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
