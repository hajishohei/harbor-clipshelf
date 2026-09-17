'use strict';
// The real icon of a macOS app bundle, in-process (no osascript: asking
// NSWorkspace for icons from osascript can hang).
//   1. Quick Look thumbnail of the .app (what Finder shows)
//   2. the bundle's .icns file named in Info.plist (CFBundleIconFile)
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

function readInfoPlist(appPath) {
  const file = path.join(appPath, 'Contents', 'Info.plist');
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.slice(0, 6).toString() === 'bplist') {
    try {
      const parsed = require('bplist-parser').parseBuffer(buf);
      return parsed && parsed[0] ? parsed[0] : null;
    } catch {
      return null;
    }
  }
  const text = buf.toString('utf8');
  const get = (key) => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return m ? m[1] : undefined;
  };
  return { CFBundleIconFile: get('CFBundleIconFile'), CFBundleIconName: get('CFBundleIconName') };
}

function icnsPath(appPath) {
  const info = readInfoPlist(appPath);
  const names = [info && info.CFBundleIconFile, info && info.CFBundleIconName, 'AppIcon'].filter(Boolean);
  for (const n of names) {
    const file = path.join(appPath, 'Contents', 'Resources', /\.icns$/i.test(n) ? n : `${n}.icns`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function appIconImage(appPath, size = 64) {
  if (process.platform !== 'darwin' || !appPath) return null;
  try {
    const img = await withTimeout(nativeImage.createThumbnailFromPath(appPath, { width: size, height: size }), 5000);
    if (img && !img.isEmpty()) return { image: img, source: 'quicklook' };
  } catch {
    /* fall through */
  }
  const icns = icnsPath(appPath);
  if (icns) {
    const img = nativeImage.createFromPath(icns);
    if (img && !img.isEmpty()) return { image: img, source: 'icns' };
  }
  return null;
}

module.exports = { appIconImage, icnsPath, readInfoPlist };
