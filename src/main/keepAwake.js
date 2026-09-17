'use strict';
const { EventEmitter } = require('events');
const { powerSaveBlocker } = require('electron');

/**
 * "Capsomnia相当": a keep-awake switch.
 *  - mode 'system'  → the Mac/PC won't idle-sleep, the display may turn off
 *                     (best for leaving an AI agent / export running)
 *  - mode 'display' → the display stays on as well
 * Can be driven manually (tray, shortcut, settings) or mirror the Caps Lock
 * state. Uses only Electron's powerSaveBlocker: no admin rights. Keeping a
 * MacBook awake with the lid closed and no external display is intentionally
 * out of scope (that needs `pmset disablesleep` with root).
 */
class KeepAwake extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.blockerId = null;
    this.blockerType = null;
    this.until = null;
    this.source = null;
    this.timer = null;
  }

  _type() {
    const s = this.getSettings();
    return s.keepAwake && s.keepAwake.mode === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension';
  }

  isActive() {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId);
  }

  state() {
    return {
      active: this.isActive(),
      until: this.until,
      source: this.source,
      mode: this.blockerType === 'prevent-display-sleep' ? 'display' : 'system'
    };
  }

  start({ durationMs = null, source = 'manual' } = {}) {
    const type = this._type();
    if (this.isActive() && this.blockerType !== type) this._release();
    if (!this.isActive()) {
      this.blockerId = powerSaveBlocker.start(type);
      this.blockerType = type;
    }
    clearTimeout(this.timer);
    this.until = durationMs ? Date.now() + durationMs : null;
    if (durationMs) this.timer = setTimeout(() => this.stop({ source: 'timer' }), durationMs);
    this.source = source;
    this.emit('change', this.state());
    return this.state();
  }

  _release() {
    if (this.blockerId !== null) {
      try {
        powerSaveBlocker.stop(this.blockerId);
      } catch {
        /* already stopped */
      }
    }
    this.blockerId = null;
    this.blockerType = null;
  }

  stop({ source = 'manual' } = {}) {
    const wasActive = this.isActive();
    clearTimeout(this.timer);
    this._release();
    this.until = null;
    this.source = source;
    if (wasActive) this.emit('change', this.state());
    return this.state();
  }

  toggle(opts = {}) {
    return this.isActive() ? this.stop(opts) : this.start(opts);
  }

  // Re-apply after the mode setting changed.
  refreshMode() {
    if (this.isActive() && this.blockerType !== this._type()) {
      const remaining = this.until ? Math.max(1000, this.until - Date.now()) : null;
      this.start({ durationMs: remaining, source: this.source });
    }
  }
}

module.exports = { KeepAwake };
