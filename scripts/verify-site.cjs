// Assembles the publish directory (recovered-site) from the prebuilt bundle in
// public/ and verifies every local asset referenced by index.html is present.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const outDir = path.join(root, 'recovered-site');

fs.mkdirSync(outDir, { recursive: true });

if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, outDir, { recursive: true });
}

const outIndex = path.join(outDir, 'index.html');
if (!fs.existsSync(outIndex)) {
  fs.copyFileSync(path.join(root, 'index.html'), outIndex);
}

const html = fs.readFileSync(outIndex, 'utf8');
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
const missing = refs.filter((ref) => !fs.existsSync(path.join(outDir, ref.split(/[?#]/)[0])));

if (missing.length) {
  console.error('recovered-site is missing assets referenced by index.html:');
  for (const ref of missing) console.error(`  - ${ref}`);
  process.exit(1);
}

console.log(`recovered-site ready (${refs.length} local assets verified).`);
