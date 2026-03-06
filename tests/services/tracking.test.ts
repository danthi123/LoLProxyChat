import { TrackingState, TrackingService } from '../../src/services/tracking';

// Mock DOM APIs needed by TrackingService constructor
const mockCtx = {} as CanvasRenderingContext2D;
const mockCanvas = {
  width: 0,
  height: 0,
  getContext: jest.fn().mockReturnValue(mockCtx),
} as unknown as HTMLCanvasElement;

(globalThis as any).document = {
  createElement: jest.fn().mockReturnValue(mockCanvas),
};

describe('TrackingState enum', () => {
  test('SCANNING = "scanning"', () => {
    expect(TrackingState.SCANNING).toBe('scanning');
  });

  test('LOCKED = "locked"', () => {
    expect(TrackingState.LOCKED).toBe('locked');
  });

  test('DEAD = "dead"', () => {
    expect(TrackingState.DEAD).toBe('dead');
  });
});

describe('TrackingService state transitions', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(1920, 1080, 'summoners_rift');
  });

  test('starts in SCANNING state', () => {
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath transitions to DEAD', () => {
    svc.onDeath();
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn transitions from DEAD to SCANNING', () => {
    svc.onDeath();
    svc.onRespawn();
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath is idempotent when already DEAD', () => {
    svc.onDeath();
    svc.onDeath(); // should not throw
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn is no-op when not DEAD', () => {
    svc.onRespawn(); // should not transition (already SCANNING)
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('getLastPosition returns null initially', () => {
    expect(svc.getLastPosition()).toBeNull();
  });
});

describe('pixelToGamePosition', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(1920, 1080, 'summoners_rift');
  });

  test('converts origin pixel to top-left game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(0, 0, region);
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(14980); // Y flipped
  });

  test('converts center pixel to center game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(50, 50, region);
    expect(pos.x).toBeCloseTo(14870 / 2);
    expect(pos.y).toBeCloseTo(14980 / 2);
  });

  test('clamps out-of-bounds pixels', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(-10, 200, region);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0); // Y flipped: relY=1 → y=0
  });
});
