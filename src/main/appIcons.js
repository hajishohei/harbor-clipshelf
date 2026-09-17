'use strict';
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const { getFileIcon } = require('./fileIcon');

/**
 * Source-app icons and their dominant colour, used for the coloured card
 * headers in the Paste-style panel. Looked up once per app and cached on disk.
 */
class AppIcons {
  constructor({ windowService, log }) {
    this.ws = windowService;
    this.log = log;
    this.file = path.join(app.getPath('userData'), 'app-icons.json');
    this.cache = {};
    this.pending = new Map();
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      this.cache = {};
    }
    this.saveTimer = null;
  }

  key(item) {
    return (item && (item.sourceBundleId || item.sourceApp)) || null;
  }

  get(key) {
    return key ? this.cache[key] || null : null;
  }

  _recentlyFailed(key) {
    const t = this.failed && this.failed.get(key);
    return !!(t && Date.now() - t < 10 * 60 * 1000);
  }

  // Resolve in the background; `onReady(key, entry)` when something new arrived.
  request({ bundleId, name, pid }, onReady) {
    const key = bundleId || name;
    if (!key || this.cache[key] || this.pending.has(key) || this._recentlyFailed(key)) return;
    if (!bundleId && !pid) return;
    if (!this.failed) this.failed = new Map();
    const job = this._resolve({ bundleId, pid })
      .then((entry) => {
        if (!entry) {
          this.failed.set(key, Date.now());
          return;
        }
        this.cache[key] = entry;
        this._save();
        if (onReady) onReady(key, entry);
      })
      .catch((err) => {
        this.log.warn('[icons]', key, err && err.message);
        this.failed.set(key, Date.now());
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
  }

  async _resolve({ bundleId, pid }) {
    let file = null;
    try {
      file = await this.ws.appPath({ bundleId, pid });
    } catch {
      file = null;
    }
    if (!file) return null;
    const icon = await getFileIcon(file, { size: 'normal' });
    if (!icon) return null;
    const small = icon.resize({ width: 32, height: 32, quality: 'good' });
    return { icon: small.toDataURL(), color: dominantColor(small) };
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.cache));
      } catch {
        /* cache only */
      }
    }, 1000);
  }
}

// Average of the saturated, opaque pixels (falls back to all opaque pixels).
function dominantColor(image) {
  const { width, height } = image.getSize();
  const bmp = image.toBitmap(); // BGRA
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let r2 = 0;
  let g2 = 0;
  let b2 = 0;
  let n2 = 0;
  for (let i = 0; i + 3 < bmp.length && i < width * height * 4; i += 4) {
    const a = bmp[i + 3];
    if (a < 200) continue;
    const B = bmp[i];
    const G = bmp[i + 1];
    const R = bmp[i + 2];
    r2 += R;
    g2 += G;
    b2 += B;
    n2++;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    if (max - min < 40 || max < 50) continue;
    r += R;
    g += G;
    b += B;
    n++;
  }
  const pick = n > 20 ? [r / n, g / n, b / n] : n2 ? [r2 / n2, g2 / n2, b2 / n2] : [120, 120, 130];
  return `#${pick.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

module.exports = { AppIcons, dominantColor };
