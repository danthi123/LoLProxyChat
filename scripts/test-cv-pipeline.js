#!/usr/bin/env node
/**
 * Test the minimap CV detection pipeline against calibration images.
 * Loads each minimap PNG, runs the detection algorithms, and compares
 * the detected position to the user-annotated ground truth.
 *
 * Usage: node scripts/test-cv-pipeline.js [calibration-dir]
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const EXTENSION_ID = 'iinajhkgohpicgkaecfigmiclobbmopefehjjhdp';
const calDir = process.argv[2]
  || path.join(process.env.APPDATA, 'Overwolf', EXTENSION_ID, 'calibration');

// ============================================================
// CV algorithms (ported from minimap-cv.ts)
// ============================================================

function rgbToHsv(r, g, b) {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
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
  let tealCount = 0;
  let totalSampled = 0;

  for (let angle = 0; angle < 360; angle += 10) {
    for (let r = innerR; r <= outerR; r += 1.5) {
      const px = Math.round(cx + r * Math.cos(angle * Math.PI / 180));
      const py = Math.round(cy + r * Math.sin(angle * Math.PI / 180));
      if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;

      const i = (py * imgW + px) * 4;
      const hsv = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2]);
      totalSampled++;

      if (hsv.h >= 175 && hsv.h <= 210 && hsv.s >= 0.20 && hsv.v >= 0.20) {
        tealCount++;
      }
    }
  }

  if (totalSampled === 0) return false;
  return { pass: tealCount / totalSampled >= 0.05, ratio: tealCount / totalSampled, tealCount, totalSampled };
}

function findClusters(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const clusters = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;

      const cluster = {
        size: 0, sumX: 0, sumY: 0,
        minX: x, maxX: x, minY: y, maxY: y,
      };
      const queue = [idx];
      visited[idx] = 1;

      while (queue.length > 0) {
        const ci = queue.pop();
        const cx = ci % w;
        const cy = (ci - cx) / w;

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
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    parent[find(a)] = find(b);
  }

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (clusters[i].size >= minSize && clusters[j].size >= minSize) continue;
      const a = clusters[i];
      const b = clusters[j];
      if (
        a.maxX + gap >= b.minX && b.maxX + gap >= a.minX &&
        a.maxY + gap >= b.minY && b.maxY + gap >= a.minY
      ) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i);
    const c = clusters[i];
    if (!groups.has(root)) {
      groups.set(root, { ...c });
    } else {
      const g = groups.get(root);
      g.size += c.size;
      g.sumX += c.sumX;
      g.sumY += c.sumY;
      g.minX = Math.min(g.minX, c.minX);
      g.maxX = Math.max(g.maxX, c.maxX);
      g.minY = Math.min(g.minY, c.minY);
      g.maxY = Math.max(g.maxY, c.maxY);
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
    if (darkCount > checkHeight * 0.4) {
      leftEdge = x;
      break;
    }
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
    if (darkCount > checkWidth * 0.4) {
      topEdge = y;
      break;
    }
  }

  const rawWidth = w - leftEdge;
  const rawHeight = h - topEdge;
  const size = Math.min(rawWidth, rawHeight);

  if (size < 100) return null;

  // Asymmetric insets: the minimap ornate frame is on the left/top sides
  // (where the capture meets the rest of the HUD). The right/bottom edges
  // are flush against the screen corner and need minimal inset.
  const insetLT = Math.round(size * 0.05);  // left/top: skip frame border
  const insetRB = Math.round(size * 0.01);  // right/bottom: minimal
  return {
    x: leftEdge + insetLT,
    y: topEdge + insetLT,
    width: size - insetLT - insetRB,
    height: size - insetLT - insetRB,
  };
}

function findCameraRectangle(pixels, imgW, imgH, region) {
  const whiteMask = new Uint8Array(imgW * imgH);
  let whiteCount = 0;

  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      const i = (y * imgW + x) * 4;
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) {
        whiteMask[y * imgW + x] = 1;
        whiteCount++;
      }
    }
  }

  if (whiteCount < 10) return null;

  const clusters = findClusters(whiteMask, imgW, imgH);
  const rectCandidates = clusters
    .filter((c) => {
      if (c.size < 30 || c.size > 800) return false;
      const cw = c.maxX - c.minX + 1;
      const ch = c.maxY - c.minY + 1;
      const aspect = cw / ch;
      if (aspect < 0.3 || aspect > 3.0) return false;
      const fillRatio = c.size / (cw * ch);
      if (fillRatio > 0.6) return false;
      if (cw < 15 || ch < 15) return false;
      return true;
    })
    .sort((a, b) => b.size - a.size);

  if (rectCandidates.length === 0) return null;

  const cam = rectCandidates[0];
  return {
    x: (cam.minX + cam.maxX) / 2,
    y: (cam.minY + cam.maxY) / 2,
  };
}

// Summoner's Rift dimensions
const MAP_WIDTH = 14870;
const MAP_HEIGHT = 14980;

function pixelToGamePosition(pixelX, pixelY, region) {
  const relX = Math.max(0, Math.min(1, (pixelX - region.x) / region.width));
  const relY = Math.max(0, Math.min(1, (pixelY - region.y) / region.height));
  return {
    x: relX * MAP_WIDTH,
    y: MAP_HEIGHT - relY * MAP_HEIGHT,
  };
}

// ============================================================
// Full detection pipeline
// ============================================================

function runDetection(pixels, imgW, imgH) {
  const region = detectMinimapRegion(pixels, imgW, imgH);
  if (!region) return { error: 'Failed to detect minimap region' };

  const mapSize = Math.max(region.width, region.height);
  const expectedIconDiam = mapSize * 0.05;
  const minBBox = Math.max(4, Math.round(expectedIconDiam * 0.5));
  const minArea = Math.max(6, Math.round(minBBox * minBBox * 0.25));
  const maxSingleArea = Math.round(expectedIconDiam * expectedIconDiam * 3);

  // Find colorful pixels
  const colorMask = new Uint8Array(imgW * imgH);
  let colorfulCount = 0;
  for (let y = region.y; y < region.y + region.height && y < imgH; y++) {
    for (let x = region.x; x < region.x + region.width && x < imgW; x++) {
      const i = (y * imgW + x) * 4;
      if (isColorfulPixel(pixels[i], pixels[i + 1], pixels[i + 2])) {
        colorMask[y * imgW + x] = 1;
        colorfulCount++;
      }
    }
  }

  const regionArea = region.width * region.height;
  const colorDensity = colorfulCount / regionArea;
  const erosionRadius = 1;

  // Erode by 1px to separate touching champion icons
  const erodedMask = new Uint8Array(imgW * imgH);
  for (let y = region.y + 1; y < region.y + region.height - 1 && y < imgH - 1; y++) {
    for (let x = region.x + 1; x < region.x + region.width - 1 && x < imgW - 1; x++) {
      const idx = y * imgW + x;
      if (colorMask[idx] &&
          colorMask[idx - 1] && colorMask[idx + 1] &&
          colorMask[idx - imgW] && colorMask[idx + imgW]) {
        erodedMask[idx] = 1;
      }
    }
  }

  const rawClusters = findClusters(erodedMask, imgW, imgH);
  const merged = mergeSmallFragments(rawClusters, 3, minArea);

  // Max cluster size: reject clusters bigger than ~3x a single icon
  // (allows 2 overlapping icons but rejects map-spanning blobs)
  const maxClusterArea = maxSingleArea * 3;

  // Filter to icon-sized
  const iconClusters = merged.filter((c) => {
    if (c.size < minArea) return false;
    if (c.size > maxClusterArea) return false;  // NEW: reject giant clusters
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    if (cw < minBBox || ch < minBBox) return false;
    const aspect = cw / ch;
    if (aspect < 0.3 || aspect > 3.0) return false;
    return true;
  });

  // Check teal halo
  const allyIconClusters = [];
  const allClusterInfo = [];
  for (const c of iconClusters) {
    const cx = (c.minX + c.maxX) / 2;
    const cy = (c.minY + c.maxY) / 2;
    const halfW = (c.maxX - c.minX + 1) / 2;
    const halfH = (c.maxY - c.minY + 1) / 2;
    const haloResult = hasTealHalo(pixels, imgW, imgH, cx, cy, halfW, halfH);

    // Check if it's red team
    let redPixelCount = 0;
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    for (let dy = c.minY; dy <= c.maxY; dy++) {
      for (let dx = c.minX; dx <= c.maxX; dx++) {
        const i = (dy * imgW + dx) * 4;
        if (isRedTeamColor(pixels[i], pixels[i + 1], pixels[i + 2])) redPixelCount++;
      }
    }

    const info = {
      cx: Math.round(cx),
      cy: Math.round(cy),
      size: c.size,
      bbox: `${cw}x${ch}`,
      hasTeal: haloResult.pass,
      tealRatio: haloResult.ratio.toFixed(3),
      redPixels: redPixelCount,
      relX: ((cx - region.x) / region.width).toFixed(3),
      relY: ((cy - region.y) / region.height).toFixed(3),
    };
    allClusterInfo.push(info);

    if (haloResult.pass) {
      allyIconClusters.push({ ...c, ...info });
    }
  }

  // Camera rectangle fallback
  const cameraPos = findCameraRectangle(pixels, imgW, imgH, region);

  return {
    region,
    mapSize,
    expectedIconDiam: Math.round(expectedIconDiam),
    minBBox,
    minArea,
    maxSingleArea,
    colorfulPixels: colorfulCount,
    colorDensity: colorDensity.toFixed(3),
    erosionRadius,
    rawClusterCount: rawClusters.length,
    mergedClusterCount: merged.length,
    iconClusterCount: iconClusters.length,
    allyClusterCount: allyIconClusters.length,
    allClusters: allClusterInfo,
    allyClusters: allyIconClusters.map(c => ({
      cx: c.cx, cy: c.cy, size: c.size, bbox: c.bbox,
      tealRatio: c.tealRatio, relX: c.relX, relY: c.relY,
    })),
    cameraRect: cameraPos ? {
      px: Math.round(cameraPos.x),
      py: Math.round(cameraPos.y),
      relX: ((cameraPos.x - region.x) / region.width).toFixed(3),
      relY: ((cameraPos.y - region.y) / region.height).toFixed(3),
    } : null,
  };
}

// ============================================================
// Main
// ============================================================

// Screen resolution (from full screenshot dimensions)
const SCREEN_WIDTH = 3424;
const SCREEN_HEIGHT = 1353;

function getGroundTruthCVCoords(positions, imgW) {
  // Convert screen coordinates to CV image pixel coordinates
  const captureSize = imgW; // image width = captureSize
  const cvOriginX = SCREEN_WIDTH - captureSize;
  const cvOriginY = SCREEN_HEIGHT - captureSize;

  return positions.map(p => ({
    ...p,
    cvX: p.screenX - cvOriginX,
    cvY: p.screenY - cvOriginY,
  }));
}

async function main() {
  if (!fs.existsSync(calDir)) {
    console.error('Calibration directory not found:', calDir);
    process.exit(1);
  }

  const pngFiles = fs.readdirSync(calDir)
    .filter(f => f.startsWith('minimap-') && f.endsWith('.png'))
    .sort();

  if (pngFiles.length === 0) {
    console.error('No minimap PNG files found. Run decode-calibration-images.js first.');
    process.exit(1);
  }

  let totalOK = 0, totalPositions = 0;

  for (const pngFile of pngFiles) {
    const idx = pngFile.match(/(\d+)/)[1];
    const posFile = `positions-${idx}.json`;
    const posPath = path.join(calDir, posFile);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`CAPTURE ${idx}: ${pngFile}`);
    console.log('='.repeat(70));

    // Load image
    const imgPath = path.join(calDir, pngFile);
    const { data, info } = await sharp(imgPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

    // Load ground truth and convert to CV coords
    let groundTruth = null;
    if (fs.existsSync(posPath)) {
      const raw = JSON.parse(fs.readFileSync(posPath, 'utf8'));
      groundTruth = getGroundTruthCVCoords(raw.positions, info.width);
      console.log('\nGround truth (CV coords):');
      for (const p of groundTruth) {
        console.log(`  ${p.championName}: cv(${p.cvX}, ${p.cvY}) screen(${p.screenX},${p.screenY})`);
      }
    }

    // Run detection
    const result = runDetection(pixels, info.width, info.height);

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      continue;
    }

    console.log(`\nMinimap region: x=${result.region.x} y=${result.region.y} ${result.region.width}x${result.region.height}`);
    console.log(`Icon params: diam=${result.expectedIconDiam}px minBBox=${result.minBBox} minArea=${result.minArea} maxArea=${result.maxSingleArea}`);
    console.log(`Pipeline: ${result.colorfulPixels} colorful (density=${result.colorDensity}) erosion=${result.erosionRadius}px -> ${result.rawClusterCount} raw -> ${result.mergedClusterCount} merged -> ${result.iconClusterCount} icon-sized -> ${result.allyClusterCount} ally`);

    // Show clusters sorted by size, marking ground truth matches
    console.log(`\nIcon-sized clusters (${result.allClusters.length}):`);
    for (const c of result.allClusters) {
      const tealStr = c.hasTeal ? 'TEAL' : '    ';
      const redStr = c.redPixels > 5 ? `red:${c.redPixels}` : '';
      // Check if near any ground truth
      let gtMatch = '';
      if (groundTruth) {
        for (const gt of groundTruth) {
          const dx = c.cx - gt.cvX;
          const dy = c.cy - gt.cvY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 25) gtMatch += ` <<< ${gt.championName} (${Math.round(dist)}px)`;
        }
      }
      console.log(`  [${tealStr}] (${c.cx},${c.cy}) ${c.bbox} sz=${c.size} teal=${c.tealRatio} ${redStr}${gtMatch}`);
    }

    if (result.cameraRect) {
      console.log(`\nCamera rect: (${result.cameraRect.px}, ${result.cameraRect.py})`);
    }

    // Compare with ground truth
    if (groundTruth) {
      console.log('\n--- ACCURACY ---');
      for (const gt of groundTruth) {
        totalPositions++;
        let bestDist = Infinity;
        let bestCluster = null;
        // Check all clusters (not just ally)
        for (const c of result.allClusters) {
          const dx = c.cx - gt.cvX;
          const dy = c.cy - gt.cvY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }

        let bestAllyDist = Infinity;
        let bestAllyCluster = null;
        for (const c of result.allClusters.filter(x => x.hasTeal)) {
          const dx = c.cx - gt.cvX;
          const dy = c.cy - gt.cvY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestAllyDist) {
            bestAllyDist = dist;
            bestAllyCluster = c;
          }
        }

        const status = bestDist < 15 ? 'OK' : bestDist < 30 ? 'CLOSE' : 'MISS';
        if (bestDist < 15) totalOK++;
        const tealStr = bestCluster?.hasTeal ? '+teal' : '-teal';
        console.log(`  ${gt.championName}: gt(${gt.cvX},${gt.cvY}) nearest_any=(${bestCluster?.cx},${bestCluster?.cy}) ${Math.round(bestDist)}px [${status}] ${tealStr}`);
        if (bestAllyCluster && bestAllyCluster !== bestCluster) {
          console.log(`    nearest_ally=(${bestAllyCluster.cx},${bestAllyCluster.cy}) ${Math.round(bestAllyDist)}px`);
        }
      }
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`OVERALL: ${totalOK}/${totalPositions} correct (within 15px)`);
  console.log('='.repeat(70));
}

main().catch(console.error);
