#!/usr/bin/env node
/**
 * Scrapes champion circle icons from the League of Legends wiki and generates
 * color histogram fingerprints for minimap icon matching.
 *
 * Features:
 *   - Follows wiki category structure (per-champion subcategories + special circles)
 *   - Incremental: only downloads new/changed images, removes deleted ones
 *   - Deduplicates identical histograms per champion
 *   - Organizes icons into per-champion folders
 *
 * Run: npm run update-icons
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const WIKI_API = 'https://wiki.leagueoflegends.com/en-us/api.php';
const ICONS_DIR = path.join(__dirname, '..', 'assets', 'champion-circles');
const FINGERPRINTS_PATH = path.join(__dirname, '..', 'src', 'data', 'champion-fingerprints.json');

const HISTOGRAM_BINS = 4;
const TOTAL_BINS = HISTOGRAM_BINS ** 3;
const TEMPLATE_SIZE = 20;

const META_PREFIXES = ['Old ', 'Unused ', 'WR ', 'Special ', 'TFT ', 'High definition '];

function safeDir(name) {
  return name.replace(/[^a-zA-Z0-9 '-]/g, '_');
}

function safeFile(name) {
  return name.replace(/[^a-zA-Z0-9._'-]/g, '_');
}

async function main() {
  console.log('=== Champion Icon Database Update ===\n');
  if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

  // --- Phase 1: Scan wiki for champions and their icon files ---

  console.log('Scanning Category:Champion circles...');
  const allSubcats = await getSubcategories('Category:Champion circles');
  const championCats = allSubcats.filter((t) => {
    const name = t.replace(/^Category:/, '');
    return !META_PREFIXES.some((p) => name.startsWith(p));
  });
  console.log(`  ${championCats.length} champion categories (filtered ${allSubcats.length - championCats.length} meta)`);

  console.log('Scanning Category:Special champion circles...');
  const specialCats = await getSubcategories('Category:Special champion circles');
  console.log(`  ${specialCats.length} special categories\n`);

  // Build championName → Set<fileTitle>
  const championFiles = {};
  let scanned = 0;
  for (const catTitle of championCats) {
    const name = parseName(catTitle, false);
    if (!name) continue;
    const files = await getFilesInCategory(catTitle);
    if (!championFiles[name]) championFiles[name] = new Set();
    for (const f of files) championFiles[name].add(f);
    scanned++;
    if (scanned % 30 === 0) console.log(`  ... scanned ${scanned}/${championCats.length}`);
  }
  console.log(`  ${scanned} champions scanned`);

  let specialAdded = 0;
  for (const catTitle of specialCats) {
    const name = parseName(catTitle, true);
    if (!name) continue;
    const files = await getFilesInCategory(catTitle);
    if (!championFiles[name]) championFiles[name] = new Set();
    for (const f of files) { championFiles[name].add(f); specialAdded++; }
  }
  console.log(`  ${specialAdded} special icon refs added`);

  // Convert to arrays
  for (const k of Object.keys(championFiles)) championFiles[k] = [...championFiles[k]];
  const totalFiles = Object.values(championFiles).reduce((s, f) => s + f.length, 0);
  console.log(`\nTotal: ${Object.keys(championFiles).length} champions, ${totalFiles} unique files\n`);

  // --- Phase 2: Resolve URLs and download incrementally ---

  console.log('Resolving image URLs...');
  const allTitles = Object.values(championFiles).flat();
  const imageUrls = await getImageUrls(allTitles);
  console.log(`  ${Object.keys(imageUrls).length} URLs resolved\n`);

  // Build reverse map: fileTitle → championName (for folder placement)
  const fileToChamp = new Map();
  for (const [champ, titles] of Object.entries(championFiles)) {
    for (const t of titles) fileToChamp.set(t, champ);
  }

  // Track expected files for cleanup
  const expectedPaths = new Set(); // relative paths within ICONS_DIR
  let downloaded = 0;
  let skippedExisting = 0;
  let failedDL = 0;

  console.log('Downloading icons (incremental)...');
  for (const [fileTitle, url] of Object.entries(imageUrls)) {
    const champ = fileToChamp.get(fileTitle);
    if (!champ) continue;

    const champFolder = safeDir(champ);
    const champPath = path.join(ICONS_DIR, champFolder);
    if (!fs.existsSync(champPath)) fs.mkdirSync(champPath, { recursive: true });

    const filename = safeFile(fileTitle.replace(/^File:/, ''));
    const localPath = path.join(champPath, filename);
    const relPath = path.join(champFolder, filename);
    expectedPaths.add(relPath);

    if (fs.existsSync(localPath)) {
      skippedExisting++;
      continue;
    }

    try {
      await downloadFile(url, localPath);
      downloaded++;
      if (downloaded % 100 === 0) console.log(`  ... ${downloaded} new downloads`);
    } catch (e) {
      console.error(`  x ${filename}: ${e.message}`);
      failedDL++;
    }
  }
  console.log(`  New: ${downloaded}, Existing: ${skippedExisting}, Failed: ${failedDL}`);

  // Cleanup: remove files/folders no longer on wiki
  let removed = 0;
  const champDirs = fs.readdirSync(ICONS_DIR, { withFileTypes: true });
  for (const entry of champDirs) {
    if (!entry.isDirectory()) {
      // Stale file in root
      const rel = entry.name;
      if (!expectedPaths.has(rel)) {
        fs.unlinkSync(path.join(ICONS_DIR, entry.name));
        removed++;
      }
      continue;
    }
    const dirPath = path.join(ICONS_DIR, entry.name);
    const files = fs.readdirSync(dirPath);
    for (const f of files) {
      const rel = path.join(entry.name, f);
      if (!expectedPaths.has(rel)) {
        fs.unlinkSync(path.join(dirPath, f));
        removed++;
      }
    }
    // Remove empty dirs
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  }
  if (removed > 0) console.log(`  Cleaned up ${removed} obsolete files`);
  console.log();

  // --- Phase 3: Generate fingerprints with deduplication ---

  console.log('Generating fingerprints and templates...');
  const fingerprints = {};
  const templates = {};
  let totalProcessed = 0;
  let totalDupes = 0;
  let totalTemplates = 0;
  let totalTemplateDupes = 0;

  for (const [champName, fileTitles] of Object.entries(championFiles)) {
    const hists = [];
    const seen = new Set();
    const skins = [];
    const seenTemplates = new Set();
    const champFolder = safeDir(champName);

    for (const fileTitle of fileTitles) {
      const filename = safeFile(fileTitle.replace(/^File:/, ''));
      const localPath = path.join(ICONS_DIR, champFolder, filename);
      if (!fs.existsSync(localPath)) continue;

      try {
        const { data, info } = await sharp(localPath)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Histogram fingerprint
        const hist = computeHistogram(data, info.width, info.height);
        const key = hist.map((v) => v.toFixed(6)).join(',');

        if (seen.has(key)) {
          totalDupes++;
        } else {
          seen.add(key);
          hists.push(hist);
          totalProcessed++;
        }

        // Generate downscaled circular template for minimap matching
        const templateBuf = await sharp(localPath)
          .resize(TEMPLATE_SIZE, TEMPLATE_SIZE, { fit: 'cover' })
          .ensureAlpha()
          .raw()
          .toBuffer();

        const templatePixels = [];
        const center = TEMPLATE_SIZE / 2;
        const radius = center - 1;
        for (let y = 0; y < TEMPLATE_SIZE; y++) {
          for (let x = 0; x < TEMPLATE_SIZE; x++) {
            const dx = x - center + 0.5;
            const dy = y - center + 0.5;
            const i = (y * TEMPLATE_SIZE + x) * 4;
            if (dx * dx + dy * dy <= radius * radius) {
              templatePixels.push(templateBuf[i], templateBuf[i + 1], templateBuf[i + 2]);
            } else {
              templatePixels.push(-1, -1, -1); // masked out
            }
          }
        }

        const templateKey = JSON.stringify(templatePixels);
        if (seenTemplates.has(templateKey)) {
          totalTemplateDupes++;
        } else {
          seenTemplates.add(templateKey);
          skins.push(templatePixels);
          totalTemplates++;
        }
      } catch (e) {
        // skip
      }
    }

    if (hists.length > 0) fingerprints[champName] = hists;
    if (skins.length > 0) templates[champName] = { size: TEMPLATE_SIZE, skins };

    if (Object.keys(fingerprints).length % 30 === 0 && hists.length > 0) {
      console.log(`  ... ${Object.keys(fingerprints).length} champions done`);
    }
  }

  console.log(`\n${totalProcessed} unique fingerprints across ${Object.keys(fingerprints).length} champions`);
  console.log(`${totalDupes} histogram duplicates removed`);
  console.log(`${totalTemplates} unique templates across ${Object.keys(templates).length} champions`);
  console.log(`${totalTemplateDupes} template duplicates removed\n`);

  const top = Object.entries(fingerprints)
    .map(([n, h]) => ({ n, c: h.length }))
    .sort((a, b) => b.c - a.c);
  console.log('Top by variant count:');
  for (const { n, c } of top.slice(0, 5)) console.log(`  ${n}: ${c}`);

  // --- Phase 4: Save ---

  const output = {
    generatedAt: new Date().toISOString(),
    championCount: Object.keys(fingerprints).length,
    totalIcons: totalProcessed,
    bins: HISTOGRAM_BINS,
    champions: fingerprints,
    templates,
  };

  const dir = path.dirname(FINGERPRINTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FINGERPRINTS_PATH, JSON.stringify(output));

  const sizeKB = (fs.statSync(FINGERPRINTS_PATH).size / 1024).toFixed(1);
  console.log(`\nSaved: ${FINGERPRINTS_PATH} (${sizeKB} KB)`);
}

// --- Helpers ---

function parseName(catTitle, isSpecial) {
  const t = catTitle.replace(/^Category:/, '');
  const re = isSpecial
    ? /^Special\s+(.+?)\s+circles$/i
    : /^(.+?)\s+circles$/i;
  const m = t.match(re);
  return m ? m[1] : null;
}

async function getSubcategories(cat) {
  return await getCategoryMembers(cat, 'subcat');
}

async function getFilesInCategory(cat) {
  return await getCategoryMembers(cat, 'file');
}

async function getCategoryMembers(cat, type) {
  const items = [];
  let cont = '';
  do {
    const p = new URLSearchParams({
      action: 'query', list: 'categorymembers',
      cmtitle: cat, cmlimit: '500', cmtype: type, format: 'json',
    });
    if (cont) p.set('cmcontinue', cont);
    const r = await fetch(`${WIKI_API}?${p}`);
    const d = await r.json();
    if (!d.query?.categorymembers) break;
    for (const m of d.query.categorymembers) items.push(m.title);
    cont = d.continue?.cmcontinue || '';
  } while (cont);
  return items;
}

async function getImageUrls(titles) {
  const urls = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const p = new URLSearchParams({
      action: 'query', titles: batch.join('|'),
      prop: 'imageinfo', iiprop: 'url', format: 'json',
    });
    const r = await fetch(`${WIKI_API}?${p}`);
    const d = await r.json();
    if (!d.query?.pages) continue;
    for (const pg of Object.values(d.query.pages)) {
      if (pg.imageinfo?.[0]?.url) urls[pg.title] = pg.imageinfo[0].url;
    }
  }
  return urls;
}

async function downloadFile(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function computeHistogram(data, width, height) {
  const hist = new Array(TOTAL_BINS).fill(0);
  let total = 0;
  const cx = width / 2, cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const rB = Math.min(HISTOGRAM_BINS - 1, data[i] >> 6);
      const gB = Math.min(HISTOGRAM_BINS - 1, data[i + 1] >> 6);
      const bB = Math.min(HISTOGRAM_BINS - 1, data[i + 2] >> 6);
      hist[rB * HISTOGRAM_BINS * HISTOGRAM_BINS + gB * HISTOGRAM_BINS + bB]++;
      total++;
    }
  }
  if (total > 0) for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return hist;
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
