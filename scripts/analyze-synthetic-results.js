const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const dir = path.join(__dirname, 'synthetic-data');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

// Run test and capture output
const output = execFileSync('node', ['scripts/test-cv-synthetic.js'], {
  encoding: 'utf8',
  cwd: path.join(__dirname, '..'),
});

// Buckets: by proximity, by map, by team
const buckets = {};
function getBucket(key) {
  if (!buckets[key]) buckets[key] = { total: 0, ok15: 0, ok25: 0, dists: [] };
  return buckets[key];
}

for (const f of files) {
  const gt = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const proximity = gt.proximity || 'unknown';
  const mapType = gt.mapType || 'unknown';
  const scenario = gt.scenario || 'unknown';

  // Find matching line in test output
  const base = f.replace('.json', '.png');
  let line = null;
  for (const l of output.split('\n')) {
    if (l.includes(base)) { line = l; break; }
  }

  // For OK files (not in output since they pass), reconstruct from ground truth
  // The test only prints PARTIAL/FAIL lines; OK files have all <= 15px
  const champs = gt.champions;
  if (!line) {
    // All OK — record 0px for each champion
    for (const c of champs) {
      const d = 0; // approximate; OK means all <= 15px
      for (const key of [`proximity:${proximity}`, `map:${mapType}`, `team:${c.team}`, `scenario:${scenario}`, 'overall']) {
        const b = getBucket(key);
        b.total++; b.ok15++; b.ok25++; b.dists.push(d);
      }
    }
    continue;
  }

  // Parse distances from the line
  // Format: "ChampName(t):NNpx ChampName(t):NNpx ..."
  const distMatches = [...line.matchAll(/\(([ae])\):(\d+)px/g)];
  for (const m of distMatches) {
    const team = m[1] === 'a' ? 'ally' : 'enemy';
    const d = parseInt(m[2]);
    for (const key of [`proximity:${proximity}`, `map:${mapType}`, `team:${team}`, `scenario:${scenario}`, 'overall']) {
      const b = getBucket(key);
      b.total++;
      b.dists.push(d);
      if (d <= 15) b.ok15++;
      if (d <= 25) b.ok25++;
    }
  }
}

const pct = (n, d) => d > 0 ? (100 * n / d).toFixed(1) + '%' : 'N/A';
function printBucket(label, b) {
  if (b.total === 0) return;
  const sorted = [...b.dists].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const max = sorted[sorted.length - 1];
  console.log(`  ${label.padEnd(25)} ${String(b.ok15).padStart(4)}/${String(b.total).padStart(4)} ≤15px(${pct(b.ok15,b.total).padStart(6)})  ≤25px(${pct(b.ok25,b.total).padStart(6)})  med=${String(med).padStart(2)}  p90=${String(p90).padStart(2)}  max=${max}`);
}

console.log('\n=== BY PROXIMITY ===');
for (const p of ['spread', 'touching', 'overlap', 'pair', 'mixed']) {
  printBucket(p, getBucket(`proximity:${p}`));
}

console.log('\n=== BY MAP ===');
for (const m of ['SR', 'HA']) {
  printBucket(m, getBucket(`map:${m}`));
}

console.log('\n=== BY TEAM ===');
for (const t of ['ally', 'enemy']) {
  printBucket(t, getBucket(`team:${t}`));
}

console.log('\n=== BY SCENARIO ===');
const scenarioKeys = Object.keys(buckets).filter(k => k.startsWith('scenario:')).sort();
for (const k of scenarioKeys) {
  printBucket(k.replace('scenario:', ''), buckets[k]);
}

console.log('\n=== OVERALL ===');
printBucket('TOTAL', getBucket('overall'));
