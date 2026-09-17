'use strict';
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { createWorker } = require('tesseract.js');
const { readBlob } = require('./blobs');
const { ocrLangDir, ocrCacheDir } = require('./paths');
const { cleanOcrText } = require('../shared/text');

const LANGS = ['jpn', 'eng'];
const IDLE_TERMINATE_MS = 5 * 60 * 1000;
const MAX_OCR_SIDE = 3000;

// Language data ships inside the app (@tesseract.js-data/*), so OCR works
// offline. tesseract.js wants all languages in one folder, so they are
// copied once into userData.
function prepareLangDir() {
  const dir = ocrLangDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of LANGS) {
    const dest = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(dest)) continue;
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    fs.copyFileSync(path.join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), dest);
  }
  return dir;
}

// Worker threads cannot execute scripts from inside app.asar; electron-builder
// unpacks tesseract.js (see package.json asarUnpack) and we point at that copy.
function workerPath() {
  const p = require.resolve('tesseract.js/src/worker-script/node/index.js');
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

class OcrService {
  constructor({ store, getSettings, deviceId, log }) {
    this.store = store;
    this.getSettings = getSettings;
    this.deviceId = deviceId;
    this.log = log;
    this.workerPromise = null;
    this.queue = [];
    this.running = false;
    this.idleTimer = null;
    this.firstUse = true;
  }

  get warm() {
    return !!this.workerPromise;
  }

  _worker() {
    clearTimeout(this.idleTimer);
    if (!this.workerPromise) {
      this.workerPromise = createWorker(LANGS.join('+'), 1, {
        langPath: prepareLangDir(),
        cachePath: ocrCacheDir(),
        gzip: true,
        workerPath: workerPath(),
        logger: () => {},
        errorHandler: (err) => this.log.warn('[ocr] worker error', err && err.message ? err.message : err)
      }).catch((err) => {
        this.workerPromise = null;
        throw err;
      });
    }
    return this.workerPromise;
  }

  _scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_TERMINATE_MS);
  }

  _prepareImage(buffer) {
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return buffer;
    const { width, height } = img.getSize();
    const side = Math.max(width, height);
    if (side <= MAX_OCR_SIDE) return buffer;
    const scale = MAX_OCR_SIDE / side;
    return img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toPNG();
  }

  async recognizeBuffer(buffer) {
    const worker = await this._worker();
    try {
      const { data } = await worker.recognize(this._prepareImage(buffer));
      return cleanOcrText(data && data.text);
    } finally {
      this._scheduleIdle();
    }
  }

  // Only images captured on *this* device are OCR'd here; synced devices
  // receive the text through the item file instead of redoing the work.
  enqueue(id, { force = false } = {}) {
    const item = this.store.get(id);
    if (!item || item.type !== 'image' || !item.blob) return;
    if (!force && item.deviceId && item.deviceId !== this.deviceId) return;
    if (!this.queue.includes(id)) this.queue.push(id);
    this._drain();
  }

  enqueuePending() {
    for (const item of this.store.list()) {
      if (item.type === 'image' && item.ocrPending) this.enqueue(item.id);
    }
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const item = this.store.get(id);
        if (!item || item.type !== 'image') continue;
        if (!this.getSettings().ocrEnabled) {
          this.store.update(id, { ocrPending: false });
          continue;
        }
        try {
          const text = await this.recognizeBuffer(readBlob(this.store.settings, item.blob));
          if (this.store.get(id)) this.store.update(id, { ocrText: text, ocrPending: false });
        } catch (err) {
          this.log.warn('[ocr] failed for', id, err && err.message);
          if (this.store.get(id)) this.store.update(id, { ocrPending: false });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async dispose() {
    clearTimeout(this.idleTimer);
    const p = this.workerPromise;
    this.workerPromise = null;
    if (p) {
      try {
        const worker = await p;
        await worker.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { OcrService, prepareLangDir, workerPath };
