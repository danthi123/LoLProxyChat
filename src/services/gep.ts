const LOL_GAME_ID = 5426;
const GEP_FEATURES = [
  'live_client_data',
  'matchState',
  'match_info',
  'summoner_info',
  'teams',
  'death',
  'respawn',
  'gameMode',
];

type GameEventCallback = (event: string, data: any) => void;
type InfoUpdateCallback = (info: any) => void;

export class GEPService {
  private onGameEvent: GameEventCallback | null = null;
  private onInfoUpdate: InfoUpdateCallback | null = null;
  private retryCount = 0;
  private readonly maxRetries = 10;
  private newEventsListener: ((e: any) => void) | null = null;
  private infoUpdatesListener: ((info: any) => void) | null = null;

  start(onGameEvent: GameEventCallback, onInfoUpdate: InfoUpdateCallback): void {
    // Guard against duplicate listeners by cleaning up any existing ones first
    this.stop();

    this.onGameEvent = onGameEvent;
    this.onInfoUpdate = onInfoUpdate;

    this.newEventsListener = (e) => {
      if (this.onGameEvent) {
        for (const event of e.events) {
          this.onGameEvent(event.name, event.data);
        }
      }
    };

    this.infoUpdatesListener = (info) => {
      if (this.onInfoUpdate) {
        this.onInfoUpdate(info);
      }
    };

    overwolf.games.events.onNewEvents.addListener(this.newEventsListener);
    overwolf.games.events.onInfoUpdates2.addListener(this.infoUpdatesListener);

    this.registerFeatures();
  }

  private registerFeatures(): void {
    overwolf.games.events.setRequiredFeatures(GEP_FEATURES, (result) => {
      if (result.success) {
        console.log('GEP features registered:', result.supportedFeatures);
        this.retryCount = 0;
      } else {
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          console.warn('GEP registration retry ' + this.retryCount + '/' + this.maxRetries);
          setTimeout(() => this.registerFeatures(), 2000);
        } else {
          console.error('GEP feature registration failed after retries');
        }
      }
    });
  }

  stop(): void {
    if (this.newEventsListener) {
      overwolf.games.events.onNewEvents.removeListener(this.newEventsListener);
      this.newEventsListener = null;
    }
    if (this.infoUpdatesListener) {
      overwolf.games.events.onInfoUpdates2.removeListener(this.infoUpdatesListener);
      this.infoUpdatesListener = null;
    }
    this.onGameEvent = null;
    this.onInfoUpdate = null;
  }
}
