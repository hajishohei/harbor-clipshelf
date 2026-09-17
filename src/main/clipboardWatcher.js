'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const io = require('./clipboardIO');
const blobs = require('./blobs');
const { isUrl, previewOf, isExcludedApp } = require('../shared/text');

const POLL_MS = 1000;
const IMAGE_SAMPLE_EVERY = 3; // polls
const SETTLE_MS = 120; // apps often write several formats in a row

/**
 * Records clipboard changes into the "history" board.
 * - Preferred: event driven by SystemMonitor ('clip' events carry the
 *   source app, so excluded apps are skipped before anything is read).
 * - Fallback: polling with a cheap fingerprint.
 */
class ClipboardWatcher extends EventEmitter {
  constructor({ store, getSettings, monitor, log }) {
    super();
    this.store = store;
    this.getSettings = getSettings;
    this.monitor = monitor;
    this.log = log;
    this.chain = Promise.resolve();
    this.settleTimer = null;
    this.pollTimer = null;
    this.pollBusy = false;
    this.pollCount = 0;
    this.lastFingerprint = null;
    this.ownWriteDepth = 0;
    this.ignoreUntil = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.monitor) {
      this.monitor.on('clip', (ev) => this._onMonitorClip(ev));
      this.monitor.on('status', () => this._updateMode());
    }
    this._updateMode();
  }

  stop() {
    this.started = false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    clearTimeout(this.settleTimer);
  }

  get mode() {
    return this.pollTimer ? 'polling' : 'monitor';
  }

  _updateMode() {
    if (!this.started) return;
    const useMonitor = this.monitor && this.monitor.available;
    if (useMonitor && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    } else if (!useMonitor && !this.pollTimer) {
      this._primeFingerprint();
      this.pollTimer = setInterval(() => this._poll(), POLL_MS);
    }
  }

  _suppressed() {
    return this.ownWriteDepth > 0 || Date.now() < this.ignoreUntil;
  }

  _onMonitorClip(ev) {
    if (this._suppressed()) return;
    // On Windows the pid is the clipboard owner, so this is exact.
    if (process.platform === 'win32' && ev.pid === process.pid) return;
    this._schedule({ source: ev });
  }

  _schedule(ctx) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this._enqueue(ctx), SETTLE_MS);
  }

  _enqueue(ctx, { force = false } = {}) {
    this.chain = this.chain
      .then(() => (!force && this._suppressed() ? null : this._capture(ctx)))
      .catch((err) => this.log.error('[clipboard] capture failed', err && err.stack ? err.stack : err));
    return this.chain;
  }

  async _primeFingerprint() {
    try {
      this.lastFingerprint = await io.quickFingerprint({ includeImage: true });
    } catch {
      this.lastFingerprint = null;
    }
  }

  async _poll() {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      this.pollCount++;
      const sampleImage = this.pollCount % IMAGE_SAMPLE_EVERY === 0;
      const fp = await io.quickFingerprint({ includeImage: sampleImage });
      const last = this.lastFingerprint || '';
      const withoutImage = (v) => v.replace(/#img:[^#]*$/, '');
      if (sampleImage ? fp === last : withoutImage(fp) === withoutImage(last)) return;
      const full = sampleImage ? fp : await io.quickFingerprint({ includeImage: true });
      if (full === last) return;
      this.lastFingerprint = full;
      if (this._suppressed()) return;
      await this._enqueue({ source: (this.monitor && this.monitor.front) || null });
    } catch (err) {
      this.log.warn('[clipboard] poll failed', err && err.message);
    } finally {
      this.pollBusy = false;
    }
  }

  // Wrap every write the app itself makes so it isn't re-captured.
  async runOwnWrite(fn) {
    this.ownWriteDepth++;
    try {
      return await fn();
    } finally {
      this.ownWriteDepth--;
      this.ignoreUntil = Date.now() + 700;
      if (this.pollTimer) await this._primeFingerprint();
    }
  }

  async _capture({ source }) {
    const s = this.getSettings();
    if (!s.captureEnabled) return null;
    if (isExcludedApp(source, s.ignoredApps)) {
      this.log.info('[clipboard] skipped (excluded app):', source && source.name);
      return null;
    }
    const snap = await io.readSnapshot();
    if (snap.confidential && s.ignoreConfidential) {
      this.emit('skipped', 'confidential');
      return null;
    }
    if (snap.transient && s.ignoreTransient) {
      this.emit('skipped', 'transient');
      return null;
    }
    if (snap.kind === 'empty') return null;
    if (snap.kind === 'too-large') {
      this.emit('skipped', 'too-large');
      return null;
    }

    const sourceFields = s.recordSourceApp && source && source.pid !== process.pid
      ? { sourceApp: source.name || null, sourceBundleId: source.bundleId || null }
      : {};
    let hash;
    let partial;

    if (snap.kind === 'text') {
      hash = `t:${io.sha1(snap.text)}`;
      partial = {
        type: isUrl(snap.text) ? 'url' : 'text',
        text: snap.text,
        html: snap.html || null,
        rtf: snap.rtf || null,
        preview: previewOf(snap.text)
      };
    } else if (snap.kind === 'files') {
      const files = [];
      for (const p of snap.files) {
        try {
          const st = fs.statSync(p);
          files.push({ name: path.basename(p) || p, size: st.isDirectory() ? null : st.size, isDir: st.isDirectory(), path: p, blob: null });
        } catch {
          /* vanished */
        }
      }
      if (!files.length) return null;
      hash = `f:${io.sha1(files.map((f) => f.path).join('\n'))}`;
      partial = { type: 'file', files, preview: files.map((f) => f.name).join(', ') };
    } else if (snap.kind === 'image') {
      const blob = blobs.saveBlob(this.store.settings, snap.png, '.png');
      hash = `i:${blob.slice(0, 64)}`;
      partial = {
        type: 'image',
        blob,
        imageSize: snap.imageSize,
        preview: `画像 ${snap.imageSize.width}×${snap.imageSize.height}`,
        ocrPending: !!s.ocrEnabled
      };
    } else {
      return null;
    }

    const existing = this.store.findHistoryByHash(hash);
    let item;
    if (existing) {
      const refresh = snap.kind === 'text' ? { html: partial.html, rtf: partial.rtf } : {};
      item = this.store.touch(existing.id, { ...refresh, ...sourceFields });
    } else {
      item = this.store.create({ board: 'history', hash, ...partial, ...sourceFields, confidential: !!snap.confidential });
    }
    this.emit('captured', item);
    return item;
  }

  // Manual "record what's on the clipboard now" (used by tests / smoke check).
  captureNow(source = null) {
    return this._enqueue({ source }, { force: true });
  }
}

module.exports = { ClipboardWatcher };
