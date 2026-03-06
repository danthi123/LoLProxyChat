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

console.log('LoLProxChat background service started');
