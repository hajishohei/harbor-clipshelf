'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { shell } = require('electron');
const M = require('../shared/mouseBindings');

/**
 * 「マウス操作」: assign actions to mouse buttons / wheel gestures, like
 * Logicool Options+ (e.g. wheel button held + wheel = switch desktops).
 *
 * The native module (native-mouse/, built in CI) watches the mouse with an
 * event tap, hides the events that have an assignment and reports them here;
 * this class decides what each one does in the app that is in front.
 */
let mod;
let loadError = null;

function candidates() {
  const key = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`;
  const root = path.join(__dirname, '..', '..');
  const rel = path.join('native', 'prebuilt', key, 'clipshelf_mouse.node');
  const list = [path.join(root, rel)];
  if (root.includes('app.asar')) list.unshift(path.join(root.replace('app.asar', 'app.asar.unpacked'), rel));
  list.push(path.join(root, 'native-mouse', 'build', 'Release', 'clipshelf_mouse.node'));
  return list;
}

function loadNative() {
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

class MouseControl extends EventEmitter {
  constructor({ getSettings, features, hud, log, native, platform }) {
    super();
    this.platform = platform || process.platform;
    this.getSettings = getSettings;
    this.features = features;
    this.hud = hud;
    this.log = log;
    this.native = native === undefined ? loadNative() : native;
    this.running = false;
    this.paused = false;
    this.error = null;
    this.observing = false;
    this.lastTrigger = null;
  }

  get supported() {
    return this.platform === 'darwin'; // Windows: next step
  }

  // Start / stop / reconfigure from the current settings.
  apply() {
    const m = this.getSettings().mouse;
    const want = !!(m && m.enabled) && this.supported;
    if (!want) {
      this._stop();
      this.error = null;
      return this.status();
    }
    if (!this.native) {
      this.error = 'missing';
      return this.status();
    }
    this._configure();
    if (!this.running) {
      try {
        this.native.start((ev) => this._onEvent(ev));
        this.running = true;
        this.error = null;
        this.native.setObserve(this.observing);
        this.log.info('[mouse] started');
      } catch (err) {
        this.error = /accessibility/.test(err.message) ? 'accessibility' : /unsupported/.test(err.message) ? 'unsupported' : err.message;
        this.log.warn('[mouse] could not start:', err.message);
      }
    }
    this.emit('change', this.status());
    return this.status();
  }

  _configure() {
    const m = this.getSettings().mouse;
    try {
      this.native.configure({
        enabled: !!m.enabled && !this.paused,
        holdMs: m.holdMs,
        gestureDistance: m.gestureDistance,
        scrollCooldownMs: m.scrollCooldownMs,
        profiles: M.profiles(m)
      });
    } catch (err) {
      this.log.warn('[mouse] configure failed', err.message);
    }
  }

  _stop() {
    if (!this.running) return;
    try {
      this.native.stop();
    } catch (err) {
      this.log.warn('[mouse] stop failed', err.message);
    }
    this.running = false;
    this.log.info('[mouse] stopped');
    this.emit('change', this.status());
  }

  stop() {
    this._stop();
  }

  onPermissionLost() {
    const wasOn = this.running;
    this._stop();
    if (wasOn || this.getSettings().mouse.enabled) this.error = 'accessibility';
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.running) this._configure();
    this.hud.show(this.paused ? 'マウス操作: 一時停止' : 'マウス操作: 再開', this.paused ? 'マウスのボタンは通常の動きに戻ります' : '設定した割り当てが使えます', { kind: 'info' });
    this.emit('change', this.status());
    return this.status();
  }

  // The settings screen wants to see which button was pressed.
  setObserve(on) {
    this.observing = !!on;
    if (this.running) {
      try {
        this.native.setObserve(this.observing);
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    const m = this.getSettings().mouse || {};
    return {
      supported: this.supported,
      available: !!this.native,
      enabled: !!m.enabled,
      running: this.running,
      paused: this.paused,
      error: this.error,
      lastTrigger: this.lastTrigger,
      loadError: !this.native && loadError ? String(loadError.message || loadError) : null
    };
  }

  _onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'press') {
      this.emit('press', { button: ev.button, app: ev.app });
      return;
    }
    if (ev.type !== 'trigger') return;
    const action = M.resolve(this.getSettings().mouse, ev.app, ev.key);
    this.lastTrigger = { key: ev.key, app: ev.app, at: Date.now(), action: action ? action.type : null };
    this.emit('trigger', this.lastTrigger);
    if (!action) return;
    this.run(action).catch((err) => this.log.warn('[mouse] action failed', action.type, err && err.message));
  }

  // Runs one action (also used by the settings screen's 「試す」).
  async run(action) {
    const a = M.normalizeAction(action);
    if (!a) return false;
    const def = M.ACTION_BY_TYPE[a.type];
    const n = this.native;
    const f = this.features;
    switch (a.type) {
      case 'none':
        return true;
      case 'spaceLeft':
      case 'spaceRight':
      case 'missionControl':
      case 'appWindows':
      case 'showDesktop':
        return this._hotKey(def.hotkey, a.type);
      case 'desktop':
        return this._hotKey(118 + a.n - 1, a.type, a.n);
      case 'shortcut': {
        const k = M.macKey(a.accelerator);
        if (!k || !n) return false;
        n.postKey(k.code, k.mods);
        return true;
      }
      case 'mouseMiddle':
      case 'mouseBack':
      case 'mouseForward':
      case 'mouseRight':
        if (!n) return false;
        n.click(def.button);
        return true;
      case 'playPause':
      case 'nextTrack':
      case 'prevTrack':
      case 'volumeUp':
      case 'volumeDown':
      case 'mute':
        if (!n) return false;
        n.postMedia(def.media);
        return true;
      case 'openHistory':
        return f.openHistory();
      case 'toggleShelf':
        return f.toggleShelf();
      case 'screenOcr':
        return f.screenOcr();
      case 'toggleKeepAwake':
        return f.toggleKeepAwake();
      case 'snap':
        return f.snap(a.layout);
      case 'openApp': {
        const err = await shell.openPath(a.target);
        if (err) this.hud.show('アプリを開けませんでした', err, { kind: 'warn' });
        return !err;
      }
      case 'openUrl':
        if (/^(https?|mailto):/i.test(a.target)) {
          await shell.openExternal(a.target);
          return true;
        } else {
          const err = await shell.openPath(a.target);
          if (err) this.hud.show('開けませんでした', err, { kind: 'warn' });
          return !err;
        }
      default:
        return false;
    }
  }

  // System shortcuts (Mission Control / Spaces): use the shortcut the user has
  // in System Settings; fall back to the standard keys / Mission Control app.
  async _hotKey(id, type, n) {
    if (this.native) {
      try {
        this.native.postHotKey(id);
        return true;
      } catch (err) {
        this.log.warn(`[mouse] hot key ${id} failed (${err.message}), using the fallback`);
      }
    }
    if (this.platform !== 'darwin') return false;
    const key = (code, mods) => {
      if (!this.native) return false;
      this.native.postKey(code, mods);
      return true;
    };
    switch (type) {
      case 'spaceLeft':
        return key(123, 1);
      case 'spaceRight':
        return key(124, 1);
      case 'desktop':
        return n <= 9 ? key(M.MAC_KEYCODES[String(n)], 1) : false;
      case 'missionControl':
        return openMissionControl([]);
      case 'appWindows':
        return openMissionControl(['--args', '2']);
      case 'showDesktop':
        return openMissionControl(['--args', '1']);
      default:
        return false;
    }
  }
}

function openMissionControl(args) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-a', 'Mission Control', ...args], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// Reads the bundle id of a chosen .app (macOS) so per-app settings follow the
// app even when its name is shown in Japanese.
function appIdentity(appPath) {
  const name = path.basename(appPath).replace(/\.(app|exe)$/i, '');
  if (process.platform !== 'darwin') return Promise.resolve({ id: path.basename(appPath).toLowerCase(), name });
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 5000 }, (err, stdout) => {
      const id = !err && String(stdout || '').trim();
      resolve(id ? { id, name } : null);
    });
  });
}

module.exports = { MouseControl, appIdentity, loadNative, lastLoadError: () => loadError };
