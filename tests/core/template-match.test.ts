import { normalizedCrossCorrelation, buildMask } from '../../src/core/template-match';

describe('normalizedCrossCorrelation', () => {
  test('returns 1.0 for identical patches', () => {
    const patch = new Uint8Array([100, 150, 200, 50, 75, 125, 200, 100, 50]);
    const template = new Int16Array([100, 150, 200, 50, 75, 125, 200, 100, 50]);
    const mask = [true, true, true];
    const score = normalizedCrossCorrelation(patch, template, mask, 3);
    expect(score).toBeCloseTo(1.0, 2);
  });

  test('returns low score for very different patches', () => {
    const patch = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0]);
    const template = new Int16Array([0, 255, 0, 0, 255, 0, 0, 255, 0]);
    const mask = [true, true, true];
    const score = normalizedCrossCorrelation(patch, template, mask, 3);
    expect(score).toBeLessThan(0.5);
  });

  test('ignores masked pixels (value -1 in template)', () => {
    const patch = new Uint8Array([100, 150, 200, 255, 255, 255, 50, 75, 100]);
    const template = new Int16Array([100, 150, 200, -1, -1, -1, 50, 75, 100]);
    const mask = [true, false, true];
    const score = normalizedCrossCorrelation(patch, template, mask, 3);
    expect(score).toBeCloseTo(1.0, 2);
  });

  test('returns 0 when all pixels are masked', () => {
    const patch = new Uint8Array([100, 150, 200]);
    const template = new Int16Array([-1, -1, -1]);
    const mask = [false];
    const score = normalizedCrossCorrelation(patch, template, mask, 1);
    expect(score).toBe(0);
  });

  test('returns 0 for constant patches (zero variance)', () => {
    const patch = new Uint8Array([100, 100, 100, 100, 100, 100]);
    const template = new Int16Array([100, 100, 100, 100, 100, 100]);
    const mask = [true, true];
    const score = normalizedCrossCorrelation(patch, template, mask, 2);
    expect(score).toBe(0);
  });
});

describe('buildMask', () => {
  test('marks pixels with all RGB >= 0 as true', () => {
    const template = [100, 150, 200, -1, -1, -1, 50, 75, 100];
    const mask = buildMask(template, 3);
    expect(mask).toEqual([true, false, true]);
  });

  test('marks pixel as false if any channel is -1', () => {
    const template = [100, -1, 200, 0, 0, 0];
    const mask = buildMask(template, 2);
    expect(mask).toEqual([false, true]);
  });

  test('returns empty array for zero pixels', () => {
    const mask = buildMask([], 0);
    expect(mask).toEqual([]);
  });
});
