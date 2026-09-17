'use strict';
const { screen, systemPreferences, shell } = require('electron');
const platform = require('./platform');

const MAC_PRIVACY_URLS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
};

/**
 * Moves / raises *other applications'* windows through the per-OS command
 * helper (JXA + System Events on macOS, PowerShell + user32 on Windows).
 * No native Node modules are involved, so nothing has to be compiled.
 */
class WindowService {
  constructor(log) {
    this.log = log;
    this.proc = null;
    this.lastProblem = null;
  }

  get supported() {
    return platform.supported;
  }

  _proc() {
    if (!this.proc) {
      this.proc = platform.createCommander(this.log);
    }
    return this.proc;
  }

  accessibilityGranted(prompt = false) {
    if (!platform.isMac) return null;
    try {
      return systemPreferences.isTrustedAccessibilityClient(prompt);
    } catch {
      return null;
    }
  }

  openPrivacyPane(kind) {
    if (platform.isMac && MAC_PRIVACY_URLS[kind]) shell.openExternal(MAC_PRIVACY_URLS[kind]);
  }

  // Returns null when OK, otherwise a short machine-readable reason.
  preflight({ prompt = false } = {}) {
    if (!this.supported) return 'unsupported';
    if (platform.isMac && this.accessibilityGranted(prompt) === false) return 'accessibility';
    const proc = this._proc();
    if (proc.failed) return 'helper-failed';
    return null;
  }

  _classify(err) {
    const msg = String((err && err.message) || err || '');
    if (/-1743|not authori[sz]ed to send apple events/i.test(msg)) return 'automation';
    if (/-1719|-25211|assistive access|accessibility/i.test(msg)) return 'accessibility';
    return 'helper-error';
  }

  async _request(cmd, params, opts) {
    try {
      const result = await this._proc().request(cmd, params, opts);
      this.lastProblem = null;
      return result;
    } catch (err) {
      this.lastProblem = { reason: this._classify(err), message: err.message };
      throw Object.assign(err, { reason: this.lastProblem.reason });
    }
  }

  // → { id, pid, app, frame (DIP), fullscreen } | null
  async getFrontWindow() {
    const raw = await this._request('getFront', { ownPid: process.pid });
    if (!raw) return null;
    if (platform.isMac) {
      return { id: String(raw.pid), pid: raw.pid, app: raw.app, frame: raw.frame, fullscreen: !!raw.fullscreen };
    }
    if (raw.minimized) return null;
    const physical = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    return { id: raw.hwnd, pid: raw.pid, app: raw.cls, frame: screen.screenToDipRect(null, physical), fullscreen: false, hwnd: raw.hwnd };
  }

  // frame in DIP; resolves with the frame the window actually ended up at.
  async setFrame(win, frame) {
    const rounded = {
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(frame.width),
      height: Math.round(frame.height)
    };
    if (platform.isMac) {
      return this._request('setFront', { pid: win.pid, frame: rounded });
    }
    const physical = screen.dipToScreenRect(null, rounded);
    const actual = await this._request('setFrame', { hwnd: win.hwnd, ...physical });
    return actual ? screen.screenToDipRect(null, actual) : rounded;
  }

  // macOS only: AutoRaise-style raise of the window under the cursor.
  // The helper is recycled every so often: the JXA bridge never frees the
  // CoreGraphics window lists it is handed, so a long-lived process grows.
  async hover(point) {
    const result = await this._request('hover', { x: Math.round(point.x), y: Math.round(point.y), ownPid: process.pid }, { timeoutMs: 4000 });
    this.hoverCount = (this.hoverCount || 0) + 1;
    if (this.hoverCount >= 1500 && this.proc && this.proc.pending.size === 0) {
      this.hoverCount = 0;
      this.resetHelper();
    }
    return result;
  }

  // Sends ⌘V / Ctrl+V to the frontmost app.
  async paste() {
    if (!this.supported) throw Object.assign(new Error('unsupported'), { reason: 'unsupported' });
    if (platform.isMac && this.accessibilityGranted(false) === false) {
      throw Object.assign(new Error('accessibility'), { reason: 'accessibility' });
    }
    return this._request('paste', {}, { timeoutMs: 4000 });
  }

  // { pid, name, bundleId } on macOS, { hwnd, pid } on Windows
  async foreground() {
    if (!this.supported) return null;
    return this._request('foreground', {}, { timeoutMs: 3000 });
  }

  async appPath({ bundleId, pid }) {
    if (!this.supported) return null;
    return this._request('appPath', { bundleId: bundleId || '', pid: Number(pid) || 0 }, { timeoutMs: 3000 });
  }

  async activate(hwnd) {
    if (!platform.isWin || !hwnd) return false;
    return this._request('activate', { hwnd: String(hwnd) }, { timeoutMs: 3000 });
  }

  async probe() {
    return this._request('probe', {});
  }

  // Windows only: the OS "activate a window by hovering over it" setting.
  async getXMouse() {
    return this._request('getXMouse', {});
  }

  async setXMouse({ enabled, raise, delayMs }) {
    return this._request('setXMouse', { enabled: !!enabled, raise: !!raise, delayMs: Math.max(0, Math.round(delayMs || 0)) });
  }

  status() {
    return {
      supported: this.supported,
      platform: process.platform,
      accessibility: this.accessibilityGranted(false),
      helper: this.proc ? this.proc.status() : { running: false },
      lastProblem: this.lastProblem
    };
  }

  resetHelper() {
    if (this.proc) {
      this.proc.stop();
      this.proc = null;
    }
    this.lastProblem = null;
  }

  stop() {
    if (this.proc) this.proc.stop();
  }
}

module.exports = { WindowService, MAC_PRIVACY_URLS };
