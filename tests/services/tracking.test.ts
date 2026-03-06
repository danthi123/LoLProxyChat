import { TrackingState } from '../../src/services/tracking';

describe('TrackingService state machine', () => {
  test('starts in SCANNING state', () => {
    expect(TrackingState.SCANNING).toBe('scanning');
  });

  test('transitions SCANNING -> LOCKED on match', () => {
    expect(TrackingState.LOCKED).toBe('locked');
  });

  test('transitions LOCKED -> DEAD on death', () => {
    expect(TrackingState.DEAD).toBe('dead');
  });

  test('transitions DEAD -> SCANNING on respawn', () => {
    expect(TrackingState.SCANNING).toBe('scanning');
  });
});
