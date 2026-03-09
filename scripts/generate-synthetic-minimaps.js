#!/usr/bin/env node
/**
 * Generate synthetic minimap images with champion icons placed at known positions.
 * Produces test images + ground truth JSON for CV pipeline calibration.
 *
 * Usage:
 *   node scripts/generate-synthetic-minimaps.js [--count N] [--map sr|ha|both] [--outdir DIR]
 *
 * Defaults: 50 images, both maps, output to scripts/synthetic-data/
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// --- Config ---
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const CHAMP_CIRCLES_DIR = path.join(ASSETS_DIR, 'champion-circles');
const SR_MINIMAP = path.join(ASSETS_DIR, 'minimap-blank-sr.png');
const HA_MINIMAP = path.join(ASSETS_DIR, 'minimap-blank-ha.png');

// Real game capture size (from map-calibration.ts: screenHeight * 0.35)
const TARGET_SIZE = 474;

// The real capture includes a dark HUD frame border around the minimap.
// From real captures, the minimap region is detected at ~(24,24) with size ~445.
// So the minimap content is inset ~24px from left/top edges of the capture.
const FRAME_BORDER = 24;
const MINIMAP_SIZE = TARGET_SIZE - FRAME_BORDER; // ~450px for minimap content

// Champion icon diameter on minimap — real icons are ~24-28px including border.
// 26px total with 3px border ring (20px portrait) matches real observations.
const ICON_DIAMETER = 26;
const BORDER_WIDTH = 3;

// Colors matching real game
const TEAL_BORDER = { r: 0, g: 200, b: 200 };   // Ally teal/cyan
const RED_BORDER = { r: 200, g: 30, b: 30 };     // Enemy red

// Allow placement anywhere on the minimap (with margin to avoid edge clipping)
const ANYWHERE_REGION = {
  isValid: (rx, ry) => {
    return rx >= 0.06 && rx <= 0.94 && ry >= 0.06 && ry <= 0.94;
  },
};

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}
const COUNT = parseInt(getArg('--count', '50'), 10);
const MAP_MODE = getArg('--map', 'both'); // sr, ha, both
const OUT_DIR = getArg('--outdir', path.join(__dirname, 'synthetic-data'));

// --- Helpers ---

/** Collect all champion icon paths (one per champion, prefer Original skin) */
function collectChampionIcons() {
  const champDirs = fs.readdirSync(CHAMP_CIRCLES_DIR);
  const icons = [];
  for (const champName of champDirs) {
    const champDir = path.join(CHAMP_CIRCLES_DIR, champName);
    if (!fs.statSync(champDir).isDirectory()) continue;
    const files = fs.readdirSync(champDir).filter(f => f.endsWith('.png'));
    if (files.length === 0) continue;
    // Prefer Original skin
    const original = files.find(f => f.includes('Original'));
    icons.push({
      champName,
      path: path.join(champDir, original || files[0]),
    });
  }
  return icons;
}

/** Create a circular champion icon with colored border ring */
async function createMinimapIcon(iconPath, borderColor, diameter) {
  const innerDiam = diameter - BORDER_WIDTH * 2;
  const radius = Math.floor(diameter / 2);
  const innerRadius = Math.floor(innerDiam / 2);

  // Resize icon to inner diameter
  const iconBuf = await sharp(iconPath)
    .resize(innerDiam, innerDiam, { fit: 'cover' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  // Create full icon with border as raw RGBA
  const fullSize = diameter;
  const pixels = Buffer.alloc(fullSize * fullSize * 4, 0);

  const cx = radius;
  const cy = radius;

  for (let y = 0; y < fullSize; y++) {
    for (let x = 0; x < fullSize; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const outIdx = (y * fullSize + x) * 4;

      if (dist <= innerRadius) {
        // Inner area: champion portrait
        const ix = x - BORDER_WIDTH;
        const iy = y - BORDER_WIDTH;
        if (ix >= 0 && ix < innerDiam && iy >= 0 && iy < innerDiam) {
          const inIdx = (iy * innerDiam + ix) * 4;
          pixels[outIdx] = iconBuf.data[inIdx];
          pixels[outIdx + 1] = iconBuf.data[inIdx + 1];
          pixels[outIdx + 2] = iconBuf.data[inIdx + 2];
          pixels[outIdx + 3] = iconBuf.data[inIdx + 3];
        }
      } else if (dist <= radius) {
        // Border ring
        pixels[outIdx] = borderColor.r;
        pixels[outIdx + 1] = borderColor.g;
        pixels[outIdx + 2] = borderColor.b;
        pixels[outIdx + 3] = 255;
      }
      // else: transparent (outside circle)
    }
  }

  return sharp(pixels, { raw: { width: fullSize, height: fullSize, channels: 4 } })
    .png()
    .toBuffer();
}

/** Pick N random items from array without replacement */
function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

/** Generate a random valid position for the given map */
function randomValidPosition(validRegion, mapWidth, mapHeight, margin, existing, minSpacing) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rx = margin / mapWidth + Math.random() * (1 - 2 * margin / mapWidth);
    const ry = margin / mapHeight + Math.random() * (1 - 2 * margin / mapHeight);
    if (!validRegion.isValid(rx, ry)) continue;

    const px = Math.round(rx * mapWidth);
    const py = Math.round(ry * mapHeight);

    // Check minimum spacing from existing icons
    let tooClose = false;
    for (const pos of existing) {
      const dx = px - pos.x;
      const dy = py - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) return { x: px, y: py };
  }
  return null; // Failed to find valid position
}

/** Generate a position near a center point (for teamfight clusters) */
function randomClusterPosition(centerX, centerY, radius, mapWidth, mapHeight, margin) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    const px = Math.round(centerX + Math.cos(angle) * dist);
    const py = Math.round(centerY + Math.sin(angle) * dist);
    if (px >= margin && px < mapWidth - margin && py >= margin && py < mapHeight - margin) {
      return { x: px, y: py };
    }
  }
  return { x: centerX, y: centerY };
}

/**
 * Scenario definitions for systematic test coverage.
 * Each scenario specifies ally/enemy count and proximity mode.
 */
const SCENARIOS = [
  // --- Isolated (well-separated icons) ---
  { allies: 1, enemies: 0, proximity: 'spread', label: '1a-solo' },
  { allies: 2, enemies: 0, proximity: 'spread', label: '2a-spread' },
  { allies: 3, enemies: 0, proximity: 'spread', label: '3a-spread' },
  { allies: 5, enemies: 0, proximity: 'spread', label: '5a-spread' },
  { allies: 1, enemies: 1, proximity: 'spread', label: '1a1e-spread' },
  { allies: 2, enemies: 2, proximity: 'spread', label: '2a2e-spread' },
  { allies: 3, enemies: 3, proximity: 'spread', label: '3a3e-spread' },
  { allies: 5, enemies: 5, proximity: 'spread', label: '5a5e-spread' },
  { allies: 1, enemies: 3, proximity: 'spread', label: '1a3e-spread' },
  { allies: 1, enemies: 5, proximity: 'spread', label: '1a5e-spread' },

  // --- Touching (borders adjacent, slight overlap) ---
  { allies: 2, enemies: 0, proximity: 'touching', label: '2a-touch' },
  { allies: 2, enemies: 1, proximity: 'touching', label: '2a1e-touch' },
  { allies: 3, enemies: 2, proximity: 'touching', label: '3a2e-touch' },
  { allies: 2, enemies: 2, proximity: 'touching', label: '2a2e-touch' },
  { allies: 1, enemies: 2, proximity: 'touching', label: '1a2e-touch' },

  // --- Overlapping (heavy overlap, like teamfight) ---
  { allies: 2, enemies: 1, proximity: 'overlap', label: '2a1e-overlap' },
  { allies: 3, enemies: 2, proximity: 'overlap', label: '3a2e-overlap' },
  { allies: 3, enemies: 3, proximity: 'overlap', label: '3a3e-overlap' },
  { allies: 5, enemies: 5, proximity: 'overlap', label: '5a5e-overlap' },
  { allies: 2, enemies: 3, proximity: 'overlap', label: '2a3e-overlap' },

  // --- Mixed: some clustered, some spread ---
  { allies: 3, enemies: 2, proximity: 'mixed', label: '3a2e-mixed' },
  { allies: 5, enemies: 3, proximity: 'mixed', label: '5a3e-mixed' },
  { allies: 2, enemies: 4, proximity: 'mixed', label: '2a4e-mixed' },

  // --- Pairs (exactly 2 icons very close, testing ally-ally, ally-enemy, enemy-enemy) ---
  { allies: 2, enemies: 0, proximity: 'pair', label: '2a-pair' },
  { allies: 1, enemies: 1, proximity: 'pair', label: '1a1e-pair' },
  { allies: 0, enemies: 2, proximity: 'pair', label: '2e-pair' },
];

/** Generate one synthetic minimap image from a scenario */
async function generateSyntheticImage(baseMapBuf, mapWidth, mapHeight, mapType, validRegion, allIcons, scenario) {
  const numAllies = scenario.allies;
  const numEnemies = scenario.enemies;
  const numChamps = numAllies + numEnemies;

  const selectedIcons = pickRandom(allIcons, numChamps);
  const positions = [];
  const absolutePositions = [];
  const iconOverlays = [];
  const margin = ICON_DIAMETER;

  // Spacing depends on proximity mode
  let minSpacing;
  switch (scenario.proximity) {
    case 'spread':  minSpacing = ICON_DIAMETER * 2.5; break;
    case 'touching': minSpacing = ICON_DIAMETER * 0.7; break;
    case 'overlap':  minSpacing = ICON_DIAMETER * 0.1; break;
    case 'pair':     minSpacing = ICON_DIAMETER * 0.3; break;
    case 'mixed':    minSpacing = ICON_DIAMETER * 0.5; break; // initial, overridden per-icon below
    default:         minSpacing = ICON_DIAMETER * 1.2;
  }

  // For 'overlap' and 'pair' modes, cluster around a center
  const useCluster = scenario.proximity === 'overlap' || scenario.proximity === 'pair';
  let clusterCenter = null;
  if (useCluster) {
    const cx = margin * 3 + Math.random() * (MINIMAP_SIZE - margin * 6);
    const cy = margin * 3 + Math.random() * (MINIMAP_SIZE - margin * 6);
    clusterCenter = { x: Math.round(cx), y: Math.round(cy) };
  }

  // For 'mixed' mode, place first group clustered, rest spread
  const mixedClusterCount = scenario.proximity === 'mixed'
    ? Math.max(2, Math.floor(numChamps * 0.5))
    : 0;
  let mixedCenter = null;
  if (mixedClusterCount > 0) {
    const cx = margin * 3 + Math.random() * (MINIMAP_SIZE - margin * 6);
    const cy = margin * 3 + Math.random() * (MINIMAP_SIZE - margin * 6);
    mixedCenter = { x: Math.round(cx), y: Math.round(cy) };
  }

  for (let i = 0; i < selectedIcons.length; i++) {
    const isAlly = i < numAllies;
    const borderColor = isAlly ? TEAL_BORDER : RED_BORDER;

    let pos;
    if (useCluster) {
      // Cluster radius varies by mode
      const maxR = scenario.proximity === 'pair'
        ? ICON_DIAMETER * 0.5                              // very tight pair
        : ICON_DIAMETER * 0.2 + Math.random() * ICON_DIAMETER * 1.0;  // overlap cluster
      pos = randomClusterPosition(clusterCenter.x, clusterCenter.y, maxR, MINIMAP_SIZE, MINIMAP_SIZE, margin);
    } else if (scenario.proximity === 'mixed' && i < mixedClusterCount) {
      pos = randomClusterPosition(mixedCenter.x, mixedCenter.y,
        ICON_DIAMETER * 0.3 + Math.random() * ICON_DIAMETER * 0.8,
        MINIMAP_SIZE, MINIMAP_SIZE, margin);
    } else {
      pos = randomValidPosition(validRegion, MINIMAP_SIZE, MINIMAP_SIZE, margin, positions, minSpacing);
    }
    if (!pos) continue;

    positions.push(pos);
    const absPos = { x: pos.x + FRAME_BORDER, y: pos.y + FRAME_BORDER };
    absolutePositions.push(absPos);

    const iconBuf = await createMinimapIcon(selectedIcons[i].path, borderColor, ICON_DIAMETER);
    iconOverlays.push({
      input: iconBuf,
      left: Math.max(0, Math.min(mapWidth - ICON_DIAMETER, absPos.x - Math.floor(ICON_DIAMETER / 2))),
      top: Math.max(0, Math.min(mapHeight - ICON_DIAMETER, absPos.y - Math.floor(ICON_DIAMETER / 2))),
    });

    selectedIcons[i].position = absPos;
    selectedIcons[i].team = isAlly ? 'ally' : 'enemy';
  }

  // Composite icons onto base map
  const result = await sharp(baseMapBuf)
    .composite(iconOverlays)
    .png()
    .toBuffer();

  const groundTruth = {
    mapType,
    scenario: scenario.label,
    proximity: scenario.proximity,
    imageWidth: mapWidth,
    imageHeight: mapHeight,
    frameBorder: FRAME_BORDER,
    iconDiameter: ICON_DIAMETER,
    champions: selectedIcons.slice(0, positions.length).map((icon, i) => ({
      championName: icon.champName,
      team: icon.team,
      x: absolutePositions[i].x,
      y: absolutePositions[i].y,
    })),
  };

  return { image: result, groundTruth };
}

// --- Main ---
async function main() {
  console.log(`Generating ${COUNT} synthetic minimap images (map: ${MAP_MODE})...`);

  // Collect champion icons
  const allIcons = collectChampionIcons();
  console.log(`Found ${allIcons.length} champion icons`);

  // Prepare output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load and resize base maps, embed in dark frame matching real captures
  async function createFramedMinimap(mapPath) {
    // Resize minimap to fit within the frame
    const minimapBuf = await sharp(mapPath)
      .resize(MINIMAP_SIZE, MINIMAP_SIZE, { fit: 'fill' })
      .png()
      .toBuffer();

    // Create dark frame (simulating the HUD border in real captures)
    // Dark border on left and top; minimap flush to right and bottom
    const framedBuf = await sharp({
      create: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 4, background: { r: 20, g: 20, b: 25, alpha: 255 } },
    })
      .composite([{ input: minimapBuf, left: FRAME_BORDER, top: FRAME_BORDER }])
      .png()
      .toBuffer();

    return framedBuf;
  }

  const maps = [];
  if (MAP_MODE === 'sr' || MAP_MODE === 'both') {
    const srBuf = await createFramedMinimap(SR_MINIMAP);
    maps.push({ buf: srBuf, type: 'SR', validRegion: ANYWHERE_REGION, w: TARGET_SIZE, h: TARGET_SIZE });
  }
  if (MAP_MODE === 'ha' || MAP_MODE === 'both') {
    const haBuf = await createFramedMinimap(HA_MINIMAP);
    maps.push({ buf: haBuf, type: 'HA', validRegion: ANYWHERE_REGION, w: TARGET_SIZE, h: TARGET_SIZE });
  }

  // Generate: each scenario × each map × REPS_PER_SCENARIO repetitions
  const repsPerScenario = Math.max(1, Math.ceil(COUNT / (SCENARIOS.length * maps.length)));
  const totalTarget = SCENARIOS.length * maps.length * repsPerScenario;
  console.log(`${SCENARIOS.length} scenarios × ${maps.length} maps × ${repsPerScenario} reps = ${totalTarget} images`);

  let generated = 0;
  for (const scenario of SCENARIOS) {
    for (const map of maps) {
      for (let rep = 0; rep < repsPerScenario; rep++) {
        generated++;
        const idx = String(generated).padStart(3, '0');
        const prefix = `synth-${map.type.toLowerCase()}-${scenario.label}-${idx}`;

        try {
          const { image, groundTruth } = await generateSyntheticImage(
            map.buf, map.w, map.h, map.type, map.validRegion, allIcons, scenario,
          );

          await sharp(image).toFile(path.join(OUT_DIR, `${prefix}.png`));
          fs.writeFileSync(
            path.join(OUT_DIR, `${prefix}.json`),
            JSON.stringify(groundTruth, null, 2),
          );

          process.stdout.write(`\r  ${generated}/${totalTarget} ${map.type} ${scenario.label}`);
        } catch (e) {
          console.error(`\nError generating ${prefix}:`, e.message);
        }
      }
    }
  }

  console.log(`\n\nGenerated ${generated} images in ${OUT_DIR}`);
}

main().catch(console.error);
