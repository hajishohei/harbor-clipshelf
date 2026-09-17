'use strict';
const { EventEmitter } = require('events');

/** "Pause Paste": stop recording copies, optionally for a while. */
class PauseController extends EventEmitter {
  constructor({ getSettings, setSettings, hud }) {
    super();
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.hud = hud;
    this.timer = null;
  }

  state() {
    const s = this.getSettings();
    return { paused: !s.captureEnabled, until: s.captureEnabled ? null : s.pausedUntil };
  }

  // Re-arms the timer after a restart.
  init() {
    const s = this.getSettings();
    if (!s.captureEnabled && s.pausedUntil) {
      if (s.pausedUntil <= Date.now()) this.resume({ silent: true });
      else this._arm(s.pausedUntil);
    }
  }

  pause(durationMs = null) {
    const until = durationMs ? Date.now() + durationMs : null;
    this.setSettings({ captureEnabled: false, pausedUntil: until });
    this._arm(until);
    this.hud.show('記録を一時停止しました', until ? `${formatUntil(until)}まで一時停止` : '再開するまで記録しません', { kind: 'info' });
    this.emit('change', this.state());
    return this.state();
  }

  resume({ silent = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    this.setSettings({ captureEnabled: true, pausedUntil: null });
    if (!silent) this.hud.show('記録を再開しました', '', { kind: 'info' });
    this.emit('change', this.state());
    return this.state();
  }

  toggle() {
    return this.state().paused ? this.resume() : this.pause(null);
  }

  // Settings screen toggles captureEnabled directly.
  syncFromSettings() {
    const s = this.getSettings();
    if (s.captureEnabled) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('change', this.state());
  }

  _arm(until) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!until) return;
    // setTimeout caps at ~24.8 days; re-check in chunks.
    const step = Math.min(until - Date.now(), 6 * 60 * 60 * 1000);
    this.timer = setTimeout(() => {
      if (Date.now() >= until - 500) this.resume();
      else this._arm(until);
    }, Math.max(1000, step));
  }

  stop() {
    clearTimeout(this.timer);
  }
}

function formatUntil(ms) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

module.exports = { PauseController, formatUntil };
