#!/usr/bin/env node
/**
 * Test overlap-based volume at various icon separation distances.
 * Generates synthetic images with Garen (ally/teal) and Vel'Koz (enemy/red)
 * at controlled distances, then runs the full CV detection pipeline and
 * reports detected pixel positions, pixel distance, and computed volume.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const CHAMP_CIRCLES_DIR = path.join(ASSETS_DIR, 'champion-circles');
const SR_MINIMAP = path.join(ASSETS_DIR, 'minimap-blank-sr.png');

const TARGET_SIZE = 474;
const FRAME_BORDER = 24;
const MINIMAP_SIZE = TARGET_SIZE - FRAME_BORDER;
const ICON_DIAMETER = 26;
const BORDER_WIDTH = 3;

const TEAL_BORDER = { r: 0, g: 200, b: 200 };
const RED_BORDER = { r: 200, g: 30, b: 30 };

// ============================================================
// CV pipeline (same as test-cv-synthetic.js)
// ============================================================

function rgbToHsv(r, g, b) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rN) h = 60 * (((gN - bN) / delta) % 6);
    else if (max === gN) h = 60 * ((bN - rN) / delta + 2);
    else h = 60 * ((rN - gN) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function isColorfulPixel(r, g, b) {
  const { s, v } = rgbToHsv(r, g, b);
  return s >= 0.45 && v >= 0.30;
}

function isTealPixel(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return h >= 170 && h <= 210 && s >= 0.35 && v >= 0.40;
}

function isRedBorderPixel(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return (h <= 20 || h >= 340) && s >= 0.50 && v >= 0.40;
}

function detectMinimapRegion(pixels, w, h) {
  const checkHeight = Math.round(h * 0.3);
  let leftEdge = 0;
  for (let x = 0; x < w * 0.6; x++) {
    let darkCount = 0;
    for (let y = h - checkHeight; y < h; y++) {
      const i = (y * w + x) * 4;
      const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      if (brightness < 70) darkCount++;
    }
    if (darkCount > checkHeight * 0.4) { leftEdge = x; break; }
  }
  const checkWidth = Math.round(w * 0.3);
  let topEdge = 0;
  for (let y = 0; y < h * 0.6; y++) {
    let darkCount = 0;
    for (let x = w - checkWidth; x < w; x++) {
      const i = (y * w + x) * 4;
      const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      if (brightness < 70) darkCount++;
    }
    if (darkCount > checkWidth * 0.4) { topEdge = y; break; }
  }
  const rawWidth = w - leftEdge;
  const rawHeight = h - topEdge;
  const size = Math.min(rawWidth, rawHeight);
  if (size < 100) return null;
  const insetLT = Math.round(size * 0.05);
  const insetRB = Math.round(size * 0.01);
  return { x: leftEdge + insetLT, y: topEdge + insetLT, width: size - insetLT - insetRB, height: size - insetLT - insetRB };
}

function ringCorrelation(pixels, imgW, imgH, region, borderTest, ringRadius, numSamples) {
  const scoreMap = new Float32Array(imgW * imgH);
  const ringOffsets = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (2 * Math.PI * i) / numSamples;
    ringOffsets.push({ dx: Math.round(ringRadius * Math.cos(angle)), dy: Math.round(ringRadius * Math.sin(angle)) });
  }
  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      let matchCount = 0, totalSamples = 0;
      for (const off of ringOffsets) {
        const px = x + off.dx, py = y + off.dy;
        if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
        totalSamples++;
        const i = (py * imgW + px) * 4;
        if (borderTest(pixels[i], pixels[i + 1], pixels[i + 2])) matchCount++;
      }
      if (totalSamples > 0) {
        let ringScore = matchCount / totalSamples;
        const ci = (y * imgW + x) * 4;
        if (borderTest(pixels[ci], pixels[ci + 1], pixels[ci + 2])) ringScore *= 0.5;
        scoreMap[y * imgW + x] = ringScore;
      }
    }
  }
  return scoreMap;
}

function findScorePeaks(scoreMap, imgW, imgH, region, minScore, suppressRadius) {
  const peaks = [];
  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      const score = scoreMap[y * imgW + x];
      if (score < minScore) continue;
      let isMax = true;
      const winR = 3;
      for (let dy = -winR; dy <= winR && isMax; dy++) {
        for (let dx = -winR; dx <= winR && isMax; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= imgW || ny < 0 || ny >= imgH) continue;
          if (scoreMap[ny * imgW + nx] > score) isMax = false;
        }
      }
      if (isMax) {
        let refinedX = x, refinedY = y;
        if (x > 0 && x < imgW - 1) {
          const sL = scoreMap[y * imgW + (x - 1)], sC = score, sR = scoreMap[y * imgW + (x + 1)];
          const denom = sL - 2 * sC + sR;
          if (denom !== 0) refinedX = x - 0.5 * (sL - sR) / denom;
        }
        if (y > 0 && y < imgH - 1) {
          const sT = scoreMap[(y - 1) * imgW + x], sC = score, sB = scoreMap[(y + 1) * imgW + x];
          const denom = sT - 2 * sC + sB;
          if (denom !== 0) refinedY = y - 0.5 * (sT - sB) / denom;
        }
        peaks.push({ x: refinedX, y: refinedY, score });
      }
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const p of peaks) {
    let suppressed = false;
    for (const k of kept) {
      const dist = Math.sqrt((p.x - k.x) ** 2 + (p.y - k.y) ** 2);
      if (dist < suppressRadius) { suppressed = true; break; }
    }
    if (!suppressed) kept.push(p);
  }
  return kept;
}

function refineWithPortrait(peaks, pixels, imgW, imgH, borderRadius, borderTest) {
  const innerR = borderRadius - 2;
  return peaks.map(peak => {
    let sumX = 0, sumY = 0, sumW = 0;
    const pcx = Math.round(peak.x), pcy = Math.round(peak.y);
    for (let dy = -innerR; dy <= innerR; dy++) {
      for (let dx = -innerR; dx <= innerR; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > innerR) continue;
        const px = pcx + dx, py = pcy + dy;
        if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
        const i = (py * imgW + px) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (isColorfulPixel(r, g, b) && !borderTest(r, g, b) && !isTealPixel(r, g, b) && !isRedBorderPixel(r, g, b)) {
          const w = 1.0 - dist / (innerR * 1.5);
          if (w > 0) { sumX += px * w; sumY += py * w; sumW += w; }
        }
      }
    }
    if (sumW > 5) {
      const newX = sumX / sumW, newY = sumY / sumW;
      const ddx = newX - peak.x, ddy = newY - peak.y;
      const disp = Math.sqrt(ddx * ddx + ddy * ddy);
      const maxDisp = 4;
      if (disp <= maxDisp) return { x: newX, y: newY, score: peak.score };
      const scale = maxDisp / disp;
      return { x: peak.x + ddx * scale, y: peak.y + ddy * scale, score: peak.score };
    }
    return peak;
  });
}

// ============================================================
// Image generation (reused from generate-synthetic-minimaps.js)
// ============================================================

async function createMinimapIcon(iconPath, borderColor, diameter) {
  const innerDiam = diameter - BORDER_WIDTH * 2;
  const radius = Math.floor(diameter / 2);
  const innerRadius = Math.floor(innerDiam / 2);
  const iconBuf = await sharp(iconPath)
    .resize(innerDiam, innerDiam, { fit: 'cover' })
    .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const fullSize = diameter;
  const pixels = Buffer.alloc(fullSize * fullSize * 4, 0);
  const cx = radius, cy = radius;
  for (let y = 0; y < fullSize; y++) {
    for (let x = 0; x < fullSize; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const outIdx = (y * fullSize + x) * 4;
      if (dist <= innerRadius) {
        const ix = x - BORDER_WIDTH, iy = y - BORDER_WIDTH;
        if (ix >= 0 && ix < innerDiam && iy >= 0 && iy < innerDiam) {
          const inIdx = (iy * innerDiam + ix) * 4;
          pixels[outIdx] = iconBuf.data[inIdx];
          pixels[outIdx + 1] = iconBuf.data[inIdx + 1];
          pixels[outIdx + 2] = iconBuf.data[inIdx + 2];
          pixels[outIdx + 3] = iconBuf.data[inIdx + 3];
        }
      } else if (dist <= radius) {
        pixels[outIdx] = borderColor.r;
        pixels[outIdx + 1] = borderColor.g;
        pixels[outIdx + 2] = borderColor.b;
        pixels[outIdx + 3] = 255;
      }
    }
  }
  return sharp(pixels, { raw: { width: fullSize, height: fullSize, channels: 4 } }).png().toBuffer();
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Find champion icons
  const garenDir = path.join(CHAMP_CIRCLES_DIR, 'Garen');
  const velkozDir = path.join(CHAMP_CIRCLES_DIR, "Vel'Koz");

  if (!fs.existsSync(garenDir)) { console.error('Garen icon dir not found:', garenDir); process.exit(1); }
  if (!fs.existsSync(velkozDir)) { console.error("Vel'Koz icon dir not found:", velkozDir); process.exit(1); }

  const garenFile = fs.readdirSync(garenDir).find(f => f.includes('Original')) || fs.readdirSync(garenDir).find(f => f.endsWith('.png'));
  const velkozFile = fs.readdirSync(velkozDir).find(f => f.includes('Original')) || fs.readdirSync(velkozDir).find(f => f.endsWith('.png'));

  const garenIcon = await createMinimapIcon(path.join(garenDir, garenFile), TEAL_BORDER, ICON_DIAMETER);
  const velkozIcon = await createMinimapIcon(path.join(velkozDir, velkozFile), RED_BORDER, ICON_DIAMETER);

  // Load blank SR minimap
  const srBase = await sharp(SR_MINIMAP)
    .resize(MINIMAP_SIZE, MINIMAP_SIZE, { fit: 'fill' })
    .png().toBuffer();

  // Test separations: from 0px (full overlap) to 40px (well beyond touching)
  const separations = [0, 2, 4, 6, 8, 10, 13, 16, 20, 26, 30, 35, 40];

  console.log('=== Overlap Volume Simulation: Garen (ally/teal) + Vel\'Koz (enemy/red) ===');
  console.log(`Icon diameter: ${ICON_DIAMETER}px, Frame border: ${FRAME_BORDER}px`);
  console.log(`Minimap size: ${MINIMAP_SIZE}px, Total image: ${TARGET_SIZE}px`);
  console.log('');
  console.log('Separation  GT_dist  Detected_dist  Volume   Status   Detection_detail');
  console.log('-'.repeat(90));

  // Place Garen at center of minimap
  const garenX = Math.round(MINIMAP_SIZE / 2);
  const garenY = Math.round(MINIMAP_SIZE / 2);

  for (const sep of separations) {
    // Place Vel'Koz to the right of Garen at this separation
    const velkozX = garenX + sep;
    const velkozY = garenY;

    // Ground truth positions in full image coords (add FRAME_BORDER)
    const gtGarenX = garenX + FRAME_BORDER;
    const gtGarenY = garenY + FRAME_BORDER;
    const gtVelkozX = velkozX + FRAME_BORDER;
    const gtVelkozY = velkozY + FRAME_BORDER;

    // Create the composite image
    const darkFrame = await sharp({
      create: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 4, background: { r: 20, g: 20, b: 25, alpha: 255 } },
    }).png().toBuffer();

    const composite = await sharp(darkFrame)
      .composite([
        { input: srBase, left: FRAME_BORDER, top: FRAME_BORDER },
        { input: garenIcon, left: garenX + FRAME_BORDER - Math.floor(ICON_DIAMETER / 2), top: garenY + FRAME_BORDER - Math.floor(ICON_DIAMETER / 2) },
        { input: velkozIcon, left: velkozX + FRAME_BORDER - Math.floor(ICON_DIAMETER / 2), top: velkozY + FRAME_BORDER - Math.floor(ICON_DIAMETER / 2) },
      ])
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const pixels = new Uint8ClampedArray(composite.data.buffer, composite.data.byteOffset, composite.data.byteLength);
    const imgW = composite.info.width;
    const imgH = composite.info.height;

    // Run CV detection
    const region = detectMinimapRegion(pixels, imgW, imgH);
    if (!region) { console.log(`${String(sep).padStart(4)}px     FAIL: No minimap region detected`); continue; }

    const mapSize = Math.max(region.width, region.height);
    const expectedIconDiam = mapSize * 0.058;
    const borderRadius = Math.round(expectedIconDiam / 2) - 1;
    const suppressRadius = Math.round(expectedIconDiam * 0.20);

    // Detect teal (Garen) and red (Vel'Koz) icons
    const tealScores = ringCorrelation(pixels, imgW, imgH, region, isTealPixel, borderRadius, 72);
    let tealPeaks = findScorePeaks(tealScores, imgW, imgH, region, 0.10, suppressRadius);
    tealPeaks = refineWithPortrait(tealPeaks, pixels, imgW, imgH, borderRadius, isTealPixel);

    const redScores = ringCorrelation(pixels, imgW, imgH, region, isRedBorderPixel, borderRadius, 72);
    let redPeaks = findScorePeaks(redScores, imgW, imgH, region, 0.10, suppressRadius);
    redPeaks = refineWithPortrait(redPeaks, pixels, imgW, imgH, borderRadius, isRedBorderPixel);

    // Find best teal peak near Garen ground truth
    let bestTeal = null, bestTealDist = Infinity;
    for (const p of tealPeaks) {
      const d = Math.sqrt((p.x - gtGarenX) ** 2 + (p.y - gtGarenY) ** 2);
      if (d < bestTealDist) { bestTealDist = d; bestTeal = p; }
    }

    // Find best red peak near Vel'Koz ground truth
    let bestRed = null, bestRedDist = Infinity;
    for (const p of redPeaks) {
      const d = Math.sqrt((p.x - gtVelkozX) ** 2 + (p.y - gtVelkozY) ** 2);
      if (d < bestRedDist) { bestRedDist = d; bestRed = p; }
    }

    if (!bestTeal || !bestRed) {
      const detail = `teal:${tealPeaks.length} red:${redPeaks.length} gtDist:${bestTealDist.toFixed(1)}/${bestRedDist.toFixed(1)}`;
      console.log(`${String(sep).padStart(4)}px     MISS: ${!bestTeal ? 'No teal' : ''} ${!bestRed ? 'No red' : ''} (${detail})`);
      continue;
    }

    // Compute detected pixel distance between the two icons
    const detectedDist = Math.sqrt((bestTeal.x - bestRed.x) ** 2 + (bestTeal.y - bestRed.y) ** 2);

    // Compute overlap volume (same formula as minimap-cv.ts getEnemyOverlapVolumes)
    const MIN_OVERLAP_VOL = 0.15;
    const maxDist = expectedIconDiam * 1.5;
    let volume;
    if (detectedDist >= maxDist) {
      volume = 0.05; // visible but not touching
    } else {
      const t = 1 - detectedDist / maxDist;
      volume = MIN_OVERLAP_VOL + (1 - MIN_OVERLAP_VOL) * t;
    }

    // Status
    const gtDist = sep;
    let status = 'OK';
    if (Math.abs(detectedDist - gtDist) > 5) status = 'DRIFT';
    if (!bestTeal || !bestRed) status = 'MISS';

    const detail = `garen@(${bestTeal.x.toFixed(1)},${bestTeal.y.toFixed(1)}) gt(${gtGarenX},${gtGarenY}) velkoz@(${bestRed.x.toFixed(1)},${bestRed.y.toFixed(1)}) gt(${gtVelkozX},${gtVelkozY})`;

    console.log(
      `${String(sep).padStart(4)}px` +
      `  ${String(gtDist).padStart(7)}px` +
      `  ${detectedDist.toFixed(1).padStart(13)}px` +
      `  ${volume.toFixed(3).padStart(7)}` +
      `  ${status.padStart(8)}` +
      `   ${detail}`
    );
  }

  console.log('');
  console.log('Expected icon diameter (from CV):', (MINIMAP_SIZE * 0.94 * 0.058).toFixed(1) + 'px');
  console.log('Synthetic icon diameter:', ICON_DIAMETER + 'px');
  console.log('');
  console.log('Key: Separation = center-to-center px in ground truth');
  console.log('     GT_dist = ground truth pixel distance');
  console.log('     Detected_dist = CV-detected pixel distance between icon centers');
  console.log('     Volume = computed overlap volume (0-1)');
}

main().catch(console.error);
