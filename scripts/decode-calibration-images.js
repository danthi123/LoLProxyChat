#!/usr/bin/env node
/**
 * Converts base64-encoded minimap calibration screenshots (.txt) to proper image files.
 *
 * Overwolf's IO API doesn't support binary file writes, so the app saves minimap
 * screenshots as data URL text files. This script decodes them to viewable PNGs.
 *
 * Usage:
 *   node scripts/decode-calibration-images.js [calibration-dir]
 *
 * Default calibration dir:
 *   %APPDATA%/Overwolf/<extension-id>/calibration
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_ID = 'iinajhkgohpicgkaecfigmiclobbmopefehjjhdp';

const calDir = process.argv[2]
  || path.join(process.env.APPDATA, 'Overwolf', EXTENSION_ID, 'calibration');

if (!fs.existsSync(calDir)) {
  console.error('Calibration directory not found:', calDir);
  process.exit(1);
}

const files = fs.readdirSync(calDir).filter(f => f.startsWith('minimap-') && f.endsWith('.txt'));

if (files.length === 0) {
  console.log('No minimap .txt files found in', calDir);
  process.exit(0);
}

let converted = 0;
for (const file of files) {
  const txtPath = path.join(calDir, file);
  const dataUrl = fs.readFileSync(txtPath, 'utf8').trim();

  // Parse data URL: "data:image/png;base64,iVBOR..."
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!match) {
    console.warn('Skipping (not a data URL):', file);
    continue;
  }

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const base64 = match[2];
  const outName = file.replace('.txt', '.' + ext);
  const outPath = path.join(calDir, outName);

  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
  converted++;
  console.log(`${file} -> ${outName}`);
}

console.log(`\nConverted ${converted}/${files.length} files in ${calDir}`);
