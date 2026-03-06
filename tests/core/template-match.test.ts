import { normalizedCrossCorrelation, buildMask, findBestMatch } from '../../src/core/template-match';

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

describe('findBestMatch', () => {
  test('finds template at correct offset in search window', () => {
    // Create a 10x10 "image" with a known 3x3 pattern at position (5,5) top-left
    const imgW = 10, imgH = 10;
    const pixels = new Uint8ClampedArray(imgW * imgH * 4); // RGBA, all zeros

    // 3x3 = 9 pixels, each with 3 RGB channels = 27 values
    const pattern = [
      255, 0, 0,   0, 255, 0,   0, 0, 255,
      128, 64, 32, 200, 100, 50, 10, 20, 30,
      50, 150, 250, 75, 175, 25, 220, 110, 55,
    ];

    // Place pattern into image at top-left (5,5)
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const imgI = ((5 + dy) * imgW + (5 + dx)) * 4;
        const pi = (dy * 3 + dx) * 3;
        pixels[imgI] = pattern[pi];
        pixels[imgI + 1] = pattern[pi + 1];
        pixels[imgI + 2] = pattern[pi + 2];
        pixels[imgI + 3] = 255;
      }
    }

    const template = new Int16Array(pattern);
    const mask = new Array(9).fill(true);
    // Center of 3x3 block at top-left (5,5) is (5+1, 5+1) = (6,6)
    const result = findBestMatch(pixels, imgW, imgH, template, mask, 3, 3, 6, 6, 4);
    expect(result.x).toBeCloseTo(6, 0);
    expect(result.y).toBeCloseTo(6, 0);
    expect(result.score).toBeGreaterThan(0.8);
  });

  test('returns low score when template not in search window', () => {
    const imgW = 10, imgH = 10;
    const pixels = new Uint8ClampedArray(imgW * imgH * 4);
    // All black image, colorful 3x1 template (3 pixels)
    const template = new Int16Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const mask = [true, true, true];
    const result = findBestMatch(pixels, imgW, imgH, template, mask, 3, 1, 5, 5, 2);
    // NCC on uniform-zero patch vs non-zero template yields 0 (zero variance in patch)
    expect(result.score).toBeLessThan(0.3);
  });
});
