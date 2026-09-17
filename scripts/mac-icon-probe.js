'use strict';
// CI check (macOS): real app icons can be read in-process.
//   npx electron scripts/mac-icon-probe.js
const { app } = require('electron');
const fs = require('fs');
const { appIconImage } = require('../src/main/macAppIcon');

app.whenReady().then(async () => {
  const apps = ['/System/Applications/Calculator.app', '/Applications/Safari.app', '/System/Library/CoreServices/Finder.app',
    '/Applications/Google Chrome.app', '/Applications/Xcode.app'].filter((p) => fs.existsSync(p));
  let ok = 0;
  for (const p of apps) {
    const t = Date.now();
    const r = await appIconImage(p, 64);
    const size = r ? r.image.getSize() : null;
    console.log(`${p}: ${r ? `${r.source} ${size.width}x${size.height}` : 'none'} (${Date.now() - t}ms)`);
    if (r) ok++;
  }
  // different apps must not all give the same picture (the old generic-icon bug)
  const pics = new Set();
  for (const p of apps.slice(0, 3)) {
    const r = await appIconImage(p, 32);
    if (r) pics.add(r.image.toDataURL());
  }
  console.log(`icons: ${ok}/${apps.length}, distinct: ${pics.size}`);
  app.exit(ok >= Math.min(2, apps.length) && pics.size >= 2 ? 0 : 1);
});
