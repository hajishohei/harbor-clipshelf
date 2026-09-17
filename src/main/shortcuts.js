'use strict';
const { globalShortcut } = require('electron');

/**
 * Keeps the set of global shortcuts in sync with settings and remembers
 * which ones failed to register (usually: another app already owns them),
 * so the settings screen can show a warning next to that field.
 */
class ShortcutManager {
  constructor(log) {
    this.log = log;
    this.handlers = {};
    this.results = {};
    this.suspended = false;
    this.lastSettings = null;
    this.temps = new Map(); // accelerator → handler (e.g. ⌘V while Paste Stack is active)
    this.localKeys = new Set();
  }

  // Global shortcuts that live outside the settings (Paste Stack's ⌘V).
  registerTemp(accelerator, handler) {
    if (this.suspended) {
      this.temps.set(accelerator, handler);
      return true;
    }
    let ok = false;
    try {
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
      ok = globalShortcut.register(accelerator, handler);
    } catch (err) {
      this.log.warn('[shortcut] temp register failed', accelerator, err.message);
    }
    if (ok) this.temps.set(accelerator, handler);
    else this.temps.delete(accelerator);
    return ok;
  }

  unregisterTemp(accelerator) {
    this.temps.delete(accelerator);
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* not registered */
    }
    // it may have shadowed a settings shortcut
    const owner = Object.entries(this.handlers).find(([k]) => this.lastSettings && this.lastSettings.shortcuts[k] === accelerator);
    if (owner && !this.suspended) {
      try {
        globalShortcut.register(accelerator, this._wrap(owner[0], owner[1]));
      } catch {
        /* ignore */
      }
    }
  }

  _wrap(key, handler) {
    return () => {
      try {
        const r = handler();
        if (r && typeof r.catch === 'function') r.catch((err) => this.log.error('[shortcut]', key, err));
      } catch (err) {
        this.log.error('[shortcut]', key, err);
      }
    };
  }

  apply(settings, handlers) {
    this.lastSettings = settings;
    this.handlers = handlers;
    if (this.suspended) return this.results;
    globalShortcut.unregisterAll();
    const results = {};
    const seen = new Map();
    for (const [key, handler] of Object.entries(handlers)) {
      const accelerator = settings.shortcuts[key];
      if (!accelerator) {
        results[key] = { accelerator: '', registered: false, reason: 'empty' };
        continue;
      }
      if (seen.has(accelerator)) {
        results[key] = { accelerator, registered: false, reason: 'duplicate', with: seen.get(accelerator) };
        continue;
      }
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, this._wrap(key, handler));
      } catch (err) {
        this.log.warn(`[shortcut] invalid accelerator "${accelerator}" for ${key}`, err.message);
      }
      if (ok) seen.set(accelerator, key);
      else this.log.warn(`[shortcut] "${accelerator}" (${key}) could not be registered`);
      results[key] = { accelerator, registered: ok, reason: ok ? null : 'in-use' };
    }
    for (const [accelerator, handler] of this.temps) {
      try {
        if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
        globalShortcut.register(accelerator, handler);
      } catch {
        /* ignore */
      }
    }
    this.results = results;
    return results;
  }

  // While the settings screen is recording a new key combination.
  suspend() {
    this.suspended = true;
    globalShortcut.unregisterAll();
  }

  resume() {
    this.suspended = false;
    if (this.lastSettings) this.apply(this.lastSettings, this.handlers);
  }

  // Validation used by the settings screen (Paste refuses combos that the
  // system or another app already owns).
  check(accelerator) {
    if (!accelerator) return { ok: true };
    const mine = Object.entries(this.results).find(([, r]) => r.accelerator === accelerator && r.registered);
    if (mine) return { ok: true, owner: mine[0] };
    try {
      const ok = globalShortcut.register(accelerator, () => {});
      if (ok) globalShortcut.unregister(accelerator);
      return ok ? { ok: true } : { ok: false, reason: 'in-use' };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  status() {
    return { suspended: this.suspended, results: this.results };
  }

  dispose() {
    globalShortcut.unregisterAll();
  }
}

module.exports = { ShortcutManager };
