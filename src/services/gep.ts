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
  private retryTimerId: number | null = null;
  private stopped = false;
  private newEventsListener: ((e: any) => void) | null = null;
  private infoUpdatesListener: ((info: any) => void) | null = null;

  start(onGameEvent: GameEventCallback, onInfoUpdate: InfoUpdateCallback): void {
    // Guard against duplicate listeners by cleaning up any existing ones first
    this.stop();
    this.stopped = false;

    this.onGameEvent = onGameEvent;
    this.onInfoUpdate = onInfoUpdate;

    this.newEventsListener = (e: any) => {
      console.log('[GEP] onNewEvents fired:', JSON.stringify(e).substring(0, 300));
      if (this.onGameEvent) {
        for (const event of e.events) {
          this.onGameEvent(event.name, event.data);
        }
      }
    };

    this.infoUpdatesListener = (info: any) => {
      console.log('[GEP] onInfoUpdates2 fired:', JSON.stringify(info).substring(0, 300));
      if (this.onInfoUpdate) {
        this.onInfoUpdate(info);
      }
    };

    console.log('[GEP] Adding listeners...');
    overwolf.games.events.onNewEvents.addListener(this.newEventsListener);
    overwolf.games.events.onInfoUpdates2.addListener(this.infoUpdatesListener);
    console.log('[GEP] Listeners added, registering features...');

    this.registerFeatures();
  }

  getInfo(callback: (info: any) => void): void {
    overwolf.games.events.getInfo((result: any) => {
      callback(result);
    });
  }

  private registerFeatures(): void {
    if (this.stopped) return;
    overwolf.games.events.setRequiredFeatures(GEP_FEATURES, (result: any) => {
      if (this.stopped) return;
      if (result.success) {
        console.log('GEP features registered:', result.supportedFeatures);
        this.retryCount = 0;
      } else {
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          console.warn('GEP registration retry ' + this.retryCount + '/' + this.maxRetries);
          this.retryTimerId = window.setTimeout(() => this.registerFeatures(), 2000) as unknown as number;
        } else {
          console.error('GEP feature registration failed after retries');
        }
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
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
