#!/usr/bin/env node
/**
 * Test the minimap CV detection pipeline against synthetic images.
 * Loads each synthetic PNG + ground truth JSON, runs detection, reports accuracy.
 *
 * Usage: node scripts/test-cv-synthetic.js [synthetic-data-dir]
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SYNTH_DIR = process.argv[2] || path.join(__dirname, 'synthetic-data');

// ============================================================
// CV algorithms (ported from minimap-cv.ts)
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

function isRedTeamColor(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return (h <= 25 || h >= 340) && s >= 0.4 && v >= 0.35;
}

function hasTealHalo(pixels, imgW, imgH, cx, cy, halfW, halfH) {
  const outerR = Math.max(halfW, halfH) + 4;
  const innerR = Math.max(halfW, halfH) + 1;
  let tealCount = 0, totalSampled = 0;
  for (let angle = 0; angle < 360; angle += 10) {
    for (let r = innerR; r <= outerR; r += 1.5) {
      const px = Math.round(cx + r * Math.cos(angle * Math.PI / 180));
      const py = Math.round(cy + r * Math.sin(angle * Math.PI / 180));
      if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
      const i = (py * imgW + px) * 4;
      const hsv = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2]);
      totalSampled++;
      if (hsv.h >= 175 && hsv.h <= 210 && hsv.s >= 0.20 && hsv.v >= 0.20) tealCount++;
    }
  }
  if (totalSampled === 0) return { pass: false, ratio: 0 };
  return { pass: tealCount / totalSampled >= 0.05, ratio: tealCount / totalSampled };
}

function findClusters(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const clusters = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;
      const cluster = { size: 0, sumX: 0, sumY: 0, minX: x, maxX: x, minY: y, maxY: y };
      const queue = [idx];
      visited[idx] = 1;
      while (queue.length > 0) {
        const ci = queue.pop();
        const cx = ci % w, cy = (ci - cx) / w;
        cluster.size++;
        cluster.sumX += cx;
        cluster.sumY += cy;
        if (cx < cluster.minX) cluster.minX = cx;
        if (cx > cluster.maxX) cluster.maxX = cx;
        if (cy < cluster.minY) cluster.minY = cy;
        if (cy > cluster.maxY) cluster.maxY = cy;
        if (cy > 0 && mask[ci - w] && !visited[ci - w]) { visited[ci - w] = 1; queue.push(ci - w); }
        if (cy < h - 1 && mask[ci + w] && !visited[ci + w]) { visited[ci + w] = 1; queue.push(ci + w); }
        if (cx > 0 && mask[ci - 1] && !visited[ci - 1]) { visited[ci - 1] = 1; queue.push(ci - 1); }
        if (cx < w - 1 && mask[ci + 1] && !visited[ci + 1]) { visited[ci + 1] = 1; queue.push(ci + 1); }
      }
      clusters.push(cluster);
    }
  }
  return clusters;
}

function mergeSmallFragments(clusters, gap, minSize) {
  if (clusters.length <= 1) return clusters;
  const parent = clusters.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (clusters[i].size >= minSize && clusters[j].size >= minSize) continue;
      const a = clusters[i], b = clusters[j];
      if (a.maxX + gap >= b.minX && b.maxX + gap >= a.minX &&
          a.maxY + gap >= b.minY && b.maxY + gap >= a.minY) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i);
    const c = clusters[i];
    if (!groups.has(root)) { groups.set(root, { ...c }); }
    else {
      const g = groups.get(root);
      g.size += c.size; g.sumX += c.sumX; g.sumY += c.sumY;
      g.minX = Math.min(g.minX, c.minX); g.maxX = Math.max(g.maxX, c.maxX);
      g.minY = Math.min(g.minY, c.minY); g.maxY = Math.max(g.maxY, c.maxY);
    }
  }
  return Array.from(groups.values());
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
  return {
    x: leftEdge + insetLT,
    y: topEdge + insetLT,
    width: size - insetLT - insetRB,
    height: size - insetLT - insetRB,
  };
}

function isTealPixel(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return h >= 170 && h <= 210 && s >= 0.35 && v >= 0.40;
}

function isRedBorderPixel(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return (h <= 20 || h >= 340) && s >= 0.50 && v >= 0.40;
}

/**
 * Ring correlation detector: for each pixel, compute what fraction of pixels
 * on a ring of the expected border radius match a border color (teal or red).
 * Local maxima in this score map are icon centers.
 */
function detectIconsByRingCorrelation(pixels, imgW, imgH, region, borderTest, ringRadius, numSamples) {
  const scoreMap = new Float32Array(imgW * imgH);

  // Precompute ring sample offsets — sample at the exact border radius only
  // Using just one radius makes the peak sharper and less affected by overlapping icons
  const ringOffsets = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (2 * Math.PI * i) / numSamples;
    ringOffsets.push({
      dx: Math.round(ringRadius * Math.cos(angle)),
      dy: Math.round(ringRadius * Math.sin(angle)),
    });
  }

  // Compute ring correlation score for each pixel in region
  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      let matchCount = 0;
      let totalSamples = 0;

      for (const off of ringOffsets) {
        const px = x + off.dx;
        const py = y + off.dy;
        if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
        totalSamples++;
        const i = (py * imgW + px) * 4;
        if (borderTest(pixels[i], pixels[i + 1], pixels[i + 2])) {
          matchCount++;
        }
      }

      if (totalSamples > 0) {
        let ringScore = matchCount / totalSamples;

        // Center penalty: at a true icon center, the pixels should be portrait
        // (colorful), not border-colored. If the center IS border-colored,
        // this is likely a position on/near someone else's border, not a center.
        const ci = (y * imgW + x) * 4;
        if (borderTest(pixels[ci], pixels[ci + 1], pixels[ci + 2])) {
          ringScore *= 0.5; // Penalize, don't eliminate (center can have slight bleed)
        }

        scoreMap[y * imgW + x] = ringScore;
      }
    }
  }

  return scoreMap;
}

/**
 * Find local maxima in a score map using non-maximum suppression.
 */
function findScorePeaks(scoreMap, imgW, imgH, region, minScore, suppressRadius) {
  const peaks = [];

  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      const score = scoreMap[y * imgW + x];
      if (score < minScore) continue;

      // Check if this is a local maximum in a window
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
        // Sub-pixel refinement via parabolic interpolation
        let refinedX = x, refinedY = y;
        // X-axis refinement
        if (x > 0 && x < imgW - 1) {
          const sL = scoreMap[y * imgW + (x - 1)];
          const sC = score;
          const sR = scoreMap[y * imgW + (x + 1)];
          const denom = sL - 2 * sC + sR;
          if (denom !== 0) refinedX = x - 0.5 * (sL - sR) / denom;
        }
        // Y-axis refinement
        if (y > 0 && y < imgH - 1) {
          const sT = scoreMap[(y - 1) * imgW + x];
          const sC = score;
          const sB = scoreMap[(y + 1) * imgW + x];
          const denom = sT - 2 * sC + sB;
          if (denom !== 0) refinedY = y - 0.5 * (sT - sB) / denom;
        }
        peaks.push({ x: refinedX, y: refinedY, score });
      }
    }
  }

  // Non-maximum suppression: remove peaks too close to higher-scoring peaks
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

function runDetection(pixels, imgW, imgH) {
  const region = detectMinimapRegion(pixels, imgW, imgH);
  if (!region) return { error: 'Failed to detect minimap region' };

  const mapSize = Math.max(region.width, region.height);
  // Icon size parameters
  const expectedIconDiam = mapSize * 0.058; // ~26px for 450px region
  const borderRadius = Math.round(expectedIconDiam / 2) - 1; // ring at outer edge of portrait
  const suppressRadius = Math.round(expectedIconDiam * 0.20); // allow very close detections
  const numSamples = 72; // 72 points around the ring (every 5°)

  // Detect ally icons (teal border ring)
  const tealScores = detectIconsByRingCorrelation(
    pixels, imgW, imgH, region, isTealPixel, borderRadius, numSamples,
  );
  const tealPeaks = findScorePeaks(tealScores, imgW, imgH, region, 0.10, suppressRadius);

  // Detect enemy icons (red border ring)
  const redScores = detectIconsByRingCorrelation(
    pixels, imgW, imgH, region, isRedBorderPixel, borderRadius, numSamples,
  );
  const redPeaks = findScorePeaks(redScores, imgW, imgH, region, 0.10, suppressRadius);

  // Refine using portrait centroid: find the center of colorful non-border
  // pixels near each peak. Portraits are unique to each icon, so this gives
  // a more accurate center when borders overlap.
  function refineWithPortrait(peaks, borderTest) {
    return peaks.map(peak => {
      const innerR = borderRadius - 2; // portrait is inside the border
      let sumX = 0, sumY = 0, sumW = 0;
      const pcx = Math.round(peak.x), pcy = Math.round(peak.y);

      for (let dy = -innerR; dy <= innerR; dy++) {
        for (let dx = -innerR; dx <= innerR; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > innerR) continue; // Only inside the expected icon circle

          const px = pcx + dx, py = pcy + dy;
          if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;

          const i = (py * imgW + px) * 4;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];

          // Must be colorful (portrait pixel) but NOT border-colored
          if (isColorfulPixel(r, g, b) && !borderTest(r, g, b) && !isTealPixel(r, g, b) && !isRedBorderPixel(r, g, b)) {
            // Weight by proximity to the detected center (favor center pixels)
            const w = 1.0 - dist / (innerR * 1.5);
            if (w > 0) {
              sumX += px * w;
              sumY += py * w;
              sumW += w;
            }
          }
        }
      }

      if (sumW > 5) {
        const newX = sumX / sumW, newY = sumY / sumW;
        // Cap displacement: don't let portrait centroid move the peak too far
        // (avoids corruption from neighboring overlapping icons' portraits)
        const maxDisp = 4;
        const dx = newX - peak.x, dy = newY - peak.y;
        const disp = Math.sqrt(dx * dx + dy * dy);
        if (disp <= maxDisp) {
          return { x: newX, y: newY, score: peak.score };
        }
        // Scale displacement to maxDisp
        const scale = maxDisp / disp;
        return { x: peak.x + dx * scale, y: peak.y + dy * scale, score: peak.score };
      }
      return peak;
    });
  }

  const refinedTealPeaks = refineWithPortrait(tealPeaks, isTealPixel);
  const refinedRedPeaks = refineWithPortrait(redPeaks, isRedBorderPixel);

  const allClusters = [
    ...refinedTealPeaks.map(p => ({ cx: Math.round(p.x), cy: Math.round(p.y), score: p.score, hasTeal: true, hasRed: false })),
    ...refinedRedPeaks.map(p => ({ cx: Math.round(p.x), cy: Math.round(p.y), score: p.score, hasTeal: false, hasRed: true })),
  ];

  return { region, colorfulCount: 0, allClusters };
}

// ============================================================
// Main
// ============================================================

async function main() {
  if (!fs.existsSync(SYNTH_DIR)) {
    console.error('Synthetic data directory not found:', SYNTH_DIR);
    process.exit(1);
  }

  const pngFiles = fs.readdirSync(SYNTH_DIR)
    .filter(f => f.startsWith('synth-') && f.endsWith('.png'))
    .sort();

  if (pngFiles.length === 0) {
    console.error('No synthetic images found. Run generate-synthetic-minimaps.js first.');
    process.exit(1);
  }

  const MATCH_THRESHOLD = 5; // px
  let totalChamps = 0, totalDetected = 0, totalAllyDetected = 0;
  let totalAllies = 0, totalEnemies = 0, allyDetected = 0, enemyDetected = 0;
  let srStats = { total: 0, detected: 0, allyTotal: 0, allyDetected: 0, enemyTotal: 0, enemyDetected: 0 };
  let haStats = { total: 0, detected: 0, allyTotal: 0, allyDetected: 0, enemyTotal: 0, enemyDetected: 0 };

  for (const pngFile of pngFiles) {
    const jsonFile = pngFile.replace('.png', '.json');
    const jsonPath = path.join(SYNTH_DIR, jsonFile);
    if (!fs.existsSync(jsonPath)) continue;

    const gt = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const { data, info } = await sharp(path.join(SYNTH_DIR, pngFile))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

    const result = runDetection(pixels, info.width, info.height);
    if (result.error) {
      console.log(`${pngFile}: ERROR - ${result.error}`);
      continue;
    }

    const stats = gt.mapType === 'SR' ? srStats : haStats;
    let fileOK = 0, fileTotal = gt.champions.length;

    for (const champ of gt.champions) {
      totalChamps++;
      stats.total++;
      const isAlly = champ.team === 'ally';
      if (isAlly) { totalAllies++; stats.allyTotal++; }
      else { totalEnemies++; stats.enemyTotal++; }

      // Find nearest cluster
      let bestDist = Infinity;
      let bestCluster = null;
      for (const c of result.allClusters) {
        const dx = c.cx - champ.x, dy = c.cy - champ.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; bestCluster = c; }
      }

      // Find nearest ally cluster (teal halo)
      let bestAllyDist = Infinity;
      for (const c of result.allClusters.filter(x => x.hasTeal)) {
        const dx = c.cx - champ.x, dy = c.cy - champ.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestAllyDist) bestAllyDist = dist;
      }

      const detected = bestDist < MATCH_THRESHOLD;
      const allyMatch = bestAllyDist < MATCH_THRESHOLD;

      if (detected) {
        totalDetected++;
        stats.detected++;
        fileOK++;
        if (isAlly) { allyDetected++; stats.allyDetected++; }
        else { enemyDetected++; stats.enemyDetected++; }
      }
    }

    const status = fileOK === fileTotal ? 'OK' : fileOK > 0 ? 'PARTIAL' : 'FAIL';
    const details = gt.champions.map(c => {
      let best = Infinity;
      for (const cl of result.allClusters) {
        const d = Math.sqrt((cl.cx - c.x) ** 2 + (cl.cy - c.y) ** 2);
        if (d < best) best = d;
      }
      return `${c.championName}(${c.team[0]}):${best < 999 ? Math.round(best) + 'px' : 'MISS'}`;
    }).join(' ');

    if (status !== 'OK') {
      console.log(`  [${status}] ${pngFile} (${fileOK}/${fileTotal}) ${details}`);
    }
  }

  // Summary
  const pct = (n, d) => d > 0 ? (100 * n / d).toFixed(1) + '%' : 'N/A';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`OVERALL: ${totalDetected}/${totalChamps} detected (${pct(totalDetected, totalChamps)})`);
  console.log(`  Allies:  ${allyDetected}/${totalAllies} (${pct(allyDetected, totalAllies)})`);
  console.log(`  Enemies: ${enemyDetected}/${totalEnemies} (${pct(enemyDetected, totalEnemies)})`);
  console.log(`\nSummoner's Rift: ${srStats.detected}/${srStats.total} (${pct(srStats.detected, srStats.total)})`);
  console.log(`  Allies:  ${srStats.allyDetected}/${srStats.allyTotal} (${pct(srStats.allyDetected, srStats.allyTotal)})`);
  console.log(`  Enemies: ${srStats.enemyDetected}/${srStats.enemyTotal} (${pct(srStats.enemyDetected, srStats.enemyTotal)})`);
  console.log(`\nHowling Abyss: ${haStats.detected}/${haStats.total} (${pct(haStats.detected, haStats.total)})`);
  console.log(`  Allies:  ${haStats.allyDetected}/${haStats.allyTotal} (${pct(haStats.allyDetected, haStats.allyTotal)})`);
  console.log(`  Enemies: ${haStats.enemyDetected}/${haStats.enemyTotal} (${pct(haStats.enemyDetected, haStats.enemyTotal)})`);
  console.log('='.repeat(60));
}

main().catch(console.error);
