import { pixelToGameUnits, getMinimapBounds } from '../../src/core/map-calibration';

describe('pixelToGameUnits', () => {
  it('converts top-left pixel to near (0, maxY) game coords for SR', () => {
    const result = pixelToGameUnits(0, 0, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(0, -2);
    expect(result.y).toBeCloseTo(14980, -2);
  });

  it('converts bottom-right pixel to near (maxX, 0) game coords for SR', () => {
    const result = pixelToGameUnits(255, 255, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(14870, -3);
    expect(result.y).toBeCloseTo(0, -3);
  });

  it('converts center pixel to center game coords', () => {
    const result = pixelToGameUnits(128, 128, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(14870 / 2, -2);
    expect(result.y).toBeCloseTo(14980 / 2, -2);
  });
});

describe('getMinimapBounds', () => {
  it('returns bounds in bottom-right of screen for 1920x1080', () => {
    const bounds = getMinimapBounds(1920, 1080);
    expect(bounds.x).toBeGreaterThan(1600);
    expect(bounds.y).toBeGreaterThan(800);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });
});
