'use strict';
const { screen } = require('electron');

const TICK_MS = 100;
const STILL_PX = 3;

/**
 * "AutoRaise相当".
 * - macOS: after the pointer has rested for `delayMs`, ask the helper to
 *   raise the topmost window under it (z-order comes from CGWindowList).
 *   The pointer is sampled cheaply; the window list is only fetched once
 *   per rest, so this costs next to nothing while the mouse is moving.
 * - Windows: uses the OS's own "activate a window by hovering over it"
 *   (X-Mouse) setting, and restores the user's previous values when turned off.
 */
class FocusFollow {
  constructor({ windowService, getSettings, setSettings, log }) {
    this.ws = windowService;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.log = log;
    this.timer = null;
    this.lastPoint = null;
    this.lastMoveAt = 0;
    this.handled = true;
    this.busy = false;
    this.lastError = null;
    this.winApplied = false;
  }

  get active() {
    return !!this.timer || this.winApplied;
  }

  // Serialised: quick ON/OFF toggles must not interleave the Windows
  // read-original / write-setting steps.
  apply() {
    this.chain = (this.chain || Promise.resolve()).then(() => this._apply()).catch((err) => {
      this.log.warn('[focusFollow] apply failed', err && err.message);
    });
    return this.chain;
  }

  async _apply() {
    const s = this.getSettings();
    const want = !!(s.focusFollowMouse && s.focusFollowMouse.enabled);
    if (process.platform === 'darwin') {
      if (want) this._startMac();
      else this._stopMac();
      return;
    }
    if (process.platform === 'win32') {
      await (want ? this._enableWin() : this._disableWin());
    }
  }

  // ---------- macOS ----------
  _startMac() {
    if (this.timer) return;
    this.handled = true;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _stopMac() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    let p;
    try {
      p = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    const now = Date.now();
    if (!this.lastPoint || Math.abs(p.x - this.lastPoint.x) > STILL_PX || Math.abs(p.y - this.lastPoint.y) > STILL_PX) {
      this.lastPoint = p;
      this.lastMoveAt = now;
      this.handled = false;
      return;
    }
    const delay = this.getSettings().focusFollowMouse.delayMs;
    if (this.handled || this.busy || now - this.lastMoveAt < delay) return;
    this.handled = true;
    if (this.ws.preflight()) return;
    this.busy = true;
    try {
      await this.ws.hover(p);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.reason || err.message;
    } finally {
      this.busy = false;
    }
  }

  // ---------- Windows ----------
  async _enableWin() {
    try {
      const s = this.getSettings();
      const current = await this.ws.getXMouse();
      if (!s.xmouseOriginal) this.setSettings({ xmouseOriginal: current });
      await this.ws.setXMouse({ enabled: true, raise: true, delayMs: s.focusFollowMouse.delayMs });
      this.winApplied = true;
      this.lastError = null;
    } catch (err) {
      this.lastError = err.reason || err.message;
      this.log.warn('[focusFollow] enable failed', err.message);
    }
  }

  async _disableWin() {
    const original = this.getSettings().xmouseOriginal;
    if (!original) {
      this.winApplied = false;
      return;
    }
    try {
      await this.ws.setXMouse(original);
      this.setSettings({ xmouseOriginal: null });
      this.winApplied = false;
    } catch (err) {
      this.lastError = err.reason || err.message;
      this.log.warn('[focusFollow] restore failed', err.message);
    }
  }

  // Called on quit: leave the OS the way we found it.
  async restoreForQuit() {
    this._stopMac();
    if (this.chain) await this.chain;
    if (process.platform === 'win32' && this.getSettings().xmouseOriginal) {
      try {
        await this.ws.setXMouse(this.getSettings().xmouseOriginal);
      } catch (err) {
        this.log.warn('[focusFollow] restore on quit failed', err.message);
      }
    }
  }

  status() {
    return { active: this.active, lastError: this.lastError };
  }
}

module.exports = { FocusFollow };
