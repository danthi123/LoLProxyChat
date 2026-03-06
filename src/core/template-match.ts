/**
 * Normalized cross-correlation between a patch (from the minimap image)
 * and a template (downscaled champion icon).
 *
 * Both are flat RGB arrays. Template pixels with value -1 are masked out.
 * Returns a score from -1.0 to 1.0 (1.0 = perfect match).
 */
export function normalizedCrossCorrelation(
  patch: Uint8Array | Uint8ClampedArray,
  template: Int16Array | number[],
  mask: boolean[],
  numPixels: number,
): number {
  let sumP = 0, sumT = 0, sumPP = 0, sumTT = 0, sumPT = 0;
  let count = 0;

  for (let i = 0; i < numPixels; i++) {
    if (!mask[i]) continue;
    const pi = i * 3;
    const pR = patch[pi], pG = patch[pi + 1], pB = patch[pi + 2];
    const tR = template[pi], tG = template[pi + 1], tB = template[pi + 2];

    sumP += pR + pG + pB;
    sumT += tR + tG + tB;
    sumPP += pR * pR + pG * pG + pB * pB;
    sumTT += tR * tR + tG * tG + tB * tB;
    sumPT += pR * tR + pG * tG + pB * tB;
    count += 3;
  }

  if (count === 0) return 0;

  const meanP = sumP / count;
  const meanT = sumT / count;
  const varP = sumPP / count - meanP * meanP;
  const varT = sumTT / count - meanT * meanT;
  const cov = sumPT / count - meanP * meanT;

  const denom = Math.sqrt(varP * varT);
  if (denom < 1e-6) return 0;

  return cov / denom;
}

/**
 * Build mask array from template: true for pixels where all RGB >= 0.
 */
export function buildMask(template: number[], numPixels: number): boolean[] {
  const mask: boolean[] = [];
  for (let i = 0; i < numPixels; i++) {
    const pi = i * 3;
    mask.push(template[pi] >= 0 && template[pi + 1] >= 0 && template[pi + 2] >= 0);
  }
  return mask;
}
