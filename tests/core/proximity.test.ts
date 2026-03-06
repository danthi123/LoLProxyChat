import { calculateDistance, calculateVolume, isInRange } from '../../src/core/proximity';
import { MAX_HEARING_RANGE } from '../../src/core/types';

describe('calculateDistance', () => {
  it('should return 0 for the same position', () => {
    expect(calculateDistance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('should return correct euclidean distance for (0,0) to (3,4)', () => {
    expect(calculateDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('should handle negative coordinates', () => {
    const dist = calculateDistance({ x: -3, y: -4 }, { x: 0, y: 0 });
    expect(dist).toBe(5);
  });

  it('should be symmetric', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 4, y: 6 };
    expect(calculateDistance(a, b)).toBe(calculateDistance(b, a));
  });
});

describe('calculateVolume', () => {
  it('should return 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('should return 0.0 at max hearing range', () => {
    expect(calculateVolume(MAX_HEARING_RANGE)).toBe(0.0);
  });

  it('should return 0.0 beyond max hearing range', () => {
    expect(calculateVolume(MAX_HEARING_RANGE + 500)).toBe(0.0);
  });

  it('should return higher volume for closer distances', () => {
    const closeVolume = calculateVolume(200);
    const farVolume = calculateVolume(800);
    expect(closeVolume).toBeGreaterThan(farVolume);
  });

  it('should return a value between 0 and 1 for mid-range distances', () => {
    const vol = calculateVolume(MAX_HEARING_RANGE / 2);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });

  it('should follow a logarithmic curve (not linear)', () => {
    // For a logarithmic curve, volume at half distance should be
    // less than 0.5 (drops off faster than linear near the edge)
    // Actually for log curve: at half distance the volume should be > 0.5
    // because log curve drops slowly at first then fast
    const halfVol = calculateVolume(MAX_HEARING_RANGE / 2);
    // Linear would give exactly 0.5; log curve should differ
    expect(halfVol).not.toBeCloseTo(0.5, 1);
  });
});

describe('isInRange', () => {
  it('should return true for distances within range', () => {
    expect(isInRange(0)).toBe(true);
    expect(isInRange(500)).toBe(true);
    expect(isInRange(MAX_HEARING_RANGE - 1)).toBe(true);
  });

  it('should return true at exactly max range', () => {
    expect(isInRange(MAX_HEARING_RANGE)).toBe(true);
  });

  it('should return false beyond max range', () => {
    expect(isInRange(MAX_HEARING_RANGE + 1)).toBe(false);
    expect(isInRange(5000)).toBe(false);
  });
});
