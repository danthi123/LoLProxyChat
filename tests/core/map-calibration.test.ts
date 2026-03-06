import { getMinimapBounds } from '../../src/core/map-calibration';

describe('getMinimapBounds', () => {
  it('returns bounds in bottom-right of screen for 1920x1080', () => {
    const bounds = getMinimapBounds(1920, 1080);
    // captureSize = round(1080 * 0.35) = 378
    // x = 1920 - 378 = 1542, y = 1080 - 378 = 702
    expect(bounds.x).toBe(1542);
    expect(bounds.y).toBe(702);
    expect(bounds.width).toBe(378);
    expect(bounds.height).toBe(378);
  });
});
