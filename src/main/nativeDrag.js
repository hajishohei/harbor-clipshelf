'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Optional native module (native/ → built in CI by scripts/build-native.js).
 * It starts a file drag that allows *moving* the file, like Finder/Explorer
 * (Electron's own startDrag only ever copies), and tells us how it ended.
 * When it is missing (dev machines, Linux) callers fall back to
 * webContents.startDrag().
 */
let mod;
let loadError = null;

function candidates() {
  const key = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`;
  const rel = path.join('native', 'prebuilt', key, 'clipshelf_native.node');
  const root = path.join(__dirname, '..', '..');
  const list = [path.join(root, rel)];
  // packaged: native/ is unpacked next to app.asar
  if (root.includes('app.asar')) list.unshift(path.join(root.replace('app.asar', 'app.asar.unpacked'), rel));
  list.push(path.join(root, 'native', 'build', 'Release', 'clipshelf_native.node'));
  return list;
}

function load() {
  if (mod !== undefined) return mod;
  mod = null;
  if (process.env.CLIPSHELF_NO_NATIVE) return mod;
  for (const file of candidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      mod = require(file);
      break;
    } catch (err) {
      loadError = err;
    }
  }
  return mod;
}

function available() {
  return !!load();
}

// → Promise<{ operation, x, y }> resolved when the drag ends, or null when the
// native drag could not start.
function startFileDrag(win, paths, iconPng, { allowMove = false } = {}) {
  const m = load();
  if (!m || !win || win.isDestroyed()) return null;
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  // Throws synchronously when the drag cannot start → caller falls back.
  m.startDrag(win.getNativeWindowHandle(), paths, iconPng || null, (result) => resolve(result), !!allowMove);
  return done;
}

module.exports = { available, startFileDrag, lastError: () => loadError };
