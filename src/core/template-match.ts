/**
 * Normalized cross-correlation between a patch (from the minimap image)
 * and a template (downscaled champion icon).
 *
 * Both are flat RGB arrays. Template pixels with value -1 are masked out.
 * Returns a score from -1.0 to 1.0 (1.0 = perfect match).
 */
export function normalizedCrossCorrelation(
  patch: Uint8Array | Uint8ClampedArray,
  template: Int16Array | Uint8ClampedArray | number[],
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

  const product = varP * varT;
  if (product < 1e-12) return 0;
  const denom = Math.sqrt(product);

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

/**
 * Slide a template across a search window in an image and find the best NCC match.
 * Returns the center position and score of the best match.
 */
export function findBestMatch(
  pixels: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  template: Int16Array | Uint8ClampedArray,
  mask: boolean[],
  templateW: number,
  templateH: number,
  centerX: number,
  centerY: number,
  searchRadius: number,
): { x: number; y: number; score: number } {
  let bestScore = -Infinity;
  let bestX = centerX;
  let bestY = centerY;

  const halfW = Math.floor(templateW / 2);
  const halfH = Math.floor(templateH / 2);
  const numPixels = templateW * templateH;
  const patch = new Uint8Array(numPixels * 3);

  for (let sy = centerY - searchRadius; sy <= centerY + searchRadius; sy++) {
    for (let sx = centerX - searchRadius; sx <= centerX + searchRadius; sx++) {
      const startX = sx - halfW;
      const startY = sy - halfH;

      if (startX < 0 || startY < 0 ||
          startX + templateW > imgW || startY + templateH > imgH) continue;

      // Extract patch RGB from image
      for (let py = 0; py < templateH; py++) {
        for (let px = 0; px < templateW; px++) {
          const imgI = ((startY + py) * imgW + (startX + px)) * 4;
          const patchI = (py * templateW + px) * 3;
          patch[patchI] = pixels[imgI];
          patch[patchI + 1] = pixels[imgI + 1];
          patch[patchI + 2] = pixels[imgI + 2];
        }
      }

      const score = normalizedCrossCorrelation(patch, template, mask, numPixels);
      if (score > bestScore) {
        bestScore = score;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  return { x: bestX, y: bestY, score: bestScore };
}
