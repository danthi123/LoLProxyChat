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

  start(onGameEvent: GameEventCallback, onInfoUpdate: InfoUpdateCallback): void {
    this.onGameEvent = onGameEvent;
    this.onInfoUpdate = onInfoUpdate;

    overwolf.games.events.onNewEvents.addListener((e) => {
      if (this.onGameEvent) {
        for (const event of e.events) {
          this.onGameEvent(event.name, event.data);
        }
      }
    });

    overwolf.games.events.onInfoUpdates2.addListener((info) => {
      if (this.onInfoUpdate) {
        this.onInfoUpdate(info);
      }
    });

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
    overwolf.games.events.onNewEvents.removeListener(() => {});
    overwolf.games.events.onInfoUpdates2.removeListener(() => {});
  }
}
