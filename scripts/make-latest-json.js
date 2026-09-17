#!/usr/bin/env node
'use strict';
// Writes latest.json + SHA256SUMS.txt for a GitHub Release.
// usage: node scripts/make-latest-json.js --dir dist --repo owner/name --tag v1.2.0 [--changelog CHANGELOG.md]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyAsset, parseVersion } = require('../src/main/updateCore');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function notesFor(changelog, version) {
  try {
    const text = fs.readFileSync(changelog, 'utf8');
    const lines = text.split(/\r?\n/);
    const head = new RegExp(`^##\\s*v?${version.replace(/\./g, '\\.')}(\\s|$)`);
    const start = lines.findIndex((l) => head.test(l));
    if (start < 0) return '';
    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    return lines.slice(start + 1, end).join('\n').trim();
  } catch {
    return '';
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const dir = arg('dir', 'dist');
  const repo = arg('repo');
  const tag = arg('tag');
  const changelog = arg('changelog', 'CHANGELOG.md');
  if (!repo || !tag) throw new Error('--repo and --tag are required');
  const version = tag.replace(/^v/, '');
  if (!parseVersion(version)) throw new Error(`not a version tag: ${tag}`);

  const assets = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const cls = classifyAsset(name);
    if (!cls) continue;
    if (!name.includes(version)) throw new Error(`${name} does not match version ${version}`);
    const file = path.join(dir, name);
    assets.push({
      name,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      size: fs.statSync(file).size,
      sha256: sha256(file),
      ...cls
    });
  }
  if (!assets.length) throw new Error(`no installers found in ${dir}`);
  const notes = notesFor(changelog, version);
  const latest = {
    version,
    publishedAt: new Date().toISOString(),
    page: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    notes,
    assets
  };
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), assets.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'RELEASE_NOTES.md'), `${notes || `HarboR ClipShelf ${version}`}\n`);
  console.log(`latest.json: ${version}, ${assets.length} assets`);
  for (const a of assets) console.log(`  ${a.platform}/${a.kind}/${a.arch || '-'}  ${a.name}  ${a.size}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
