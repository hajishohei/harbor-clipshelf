/* Shared by the main process (require) and the settings screen (<script>):
 * what can be assigned to which mouse operation (Logicool Options+ style),
 * how assignments are stored, and how they are turned into the per-app
 * trigger sets the native engine needs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipShelfMouse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ triggers
  const BUTTONS = [
    { id: 'middle', label: 'ホイールボタン（押し込み）' },
    { id: 'back', label: '戻るボタン（サイド手前）' },
    { id: 'forward', label: '進むボタン（サイド奥）' }
  ];
  const EXTRA_BUTTON_RE = /^b([5-9]|1[0-9]|2[0-9]|3[01])$/;

  const BUTTON_TRIGGERS = [
    ['click', 'クリック'],
    ['hold', '長押し'],
    ['scrollUp', '押しながらホイールを上へ'],
    ['scrollDown', '押しながらホイールを下へ'],
    ['scrollLeft', '押しながらホイールを左へ（チルト）'],
    ['scrollRight', '押しながらホイールを右へ（チルト）'],
    ['dragUp', '押しながら上へ動かす'],
    ['dragDown', '押しながら下へ動かす'],
    ['dragLeft', '押しながら左へ動かす'],
    ['dragRight', '押しながら右へ動かす']
  ];
  const WHEEL_TRIGGERS = [
    ['tiltLeft', 'ホイールを左へ倒す（チルト）'],
    ['tiltRight', 'ホイールを右へ倒す（チルト）']
  ];
  const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
  const MOD_PRESETS = ['ctrl', 'alt', 'cmd', 'shift', 'ctrl+alt', 'alt+cmd', 'ctrl+cmd', 'ctrl+shift'];

  function buttonLabel(id) {
    const b = BUTTONS.find((x) => x.id === id);
    if (b) return b.label;
    const m = /^b(\d+)$/.exec(id || '');
    return m ? `ボタン${Number(m[1]) + 1}` : String(id);
  }

  function modsLabel(mods, platform) {
    const mac = platform === 'darwin';
    const names = mac
      ? { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' }
      : { ctrl: 'Ctrl+', alt: 'Alt+', shift: 'Shift+', cmd: 'Win+' };
    return String(mods).split('+').map((m) => names[m] || m).join('');
  }

  function isValidMods(mods) {
    if (typeof mods !== 'string' || !mods) return false;
    const parts = mods.split('+');
    let last = -1;
    for (const p of parts) {
      const i = MOD_ORDER.indexOf(p);
      if (i <= last) return false;
      last = i;
    }
    return true;
  }

  function isButtonId(id) {
    return BUTTONS.some((b) => b.id === id) || EXTRA_BUTTON_RE.test(id);
  }

  function isValidKey(key) {
    if (typeof key !== 'string') return false;
    if (WHEEL_TRIGGERS.some(([k]) => k === key)) return true;
    const dot = key.lastIndexOf('.');
    if (dot < 0) return false;
    const head = key.slice(0, dot);
    const tail = key.slice(dot + 1);
    if (isButtonId(head)) return BUTTON_TRIGGERS.some(([k]) => k === tail);
    return isValidMods(head) && (tail === 'scrollUp' || tail === 'scrollDown');
  }

  function keyLabel(key, platform) {
    const w = WHEEL_TRIGGERS.find(([k]) => k === key);
    if (w) return w[1];
    const dot = key.lastIndexOf('.');
    const head = key.slice(0, dot);
    const tail = key.slice(dot + 1);
    if (isButtonId(head)) {
      const t = BUTTON_TRIGGERS.find(([k]) => k === tail);
      return `${buttonLabel(head)}：${t ? t[1] : tail}`;
    }
    return `${modsLabel(head, platform)} を押しながらホイールを${tail === 'scrollUp' ? '上' : '下'}へ`;
  }

  // ------------------------------------------------------------ actions
  const GROUPS = [
    ['desktop', 'デスクトップ・ウィンドウ'],
    ['key', 'キー操作'],
    ['mouse', 'マウスのボタン'],
    ['media', '音楽・音量'],
    ['clipshelf', 'ClipShelf の機能'],
    ['open', '開く'],
    ['other', 'そのほか']
  ];

  // hotkey = macOS symbolic hot key id (System Settings → Keyboard shortcuts)
  const ACTIONS = [
    { type: 'spaceLeft', group: 'desktop', label: '左のデスクトップへ移動', hotkey: 79 },
    { type: 'spaceRight', group: 'desktop', label: '右のデスクトップへ移動', hotkey: 81 },
    { type: 'missionControl', group: 'desktop', label: 'デスクトップ一覧（Mission Control）', winLabel: 'デスクトップ一覧（タスクビュー）', hotkey: 32 },
    { type: 'appWindows', group: 'desktop', label: 'このアプリのウィンドウ一覧（アプリケーションウインドウ）', hotkey: 33, macOnly: true },
    { type: 'showDesktop', group: 'desktop', label: 'デスクトップを表示', hotkey: 36 },
    { type: 'desktop', group: 'desktop', label: '番号のデスクトップへ移動', param: 'n' },
    { type: 'shortcut', group: 'key', label: 'ショートカットキーを送る', param: 'accelerator' },
    { type: 'mouseMiddle', group: 'mouse', label: 'ホイールクリック', button: 2 },
    { type: 'mouseBack', group: 'mouse', label: '戻るボタン', button: 3 },
    { type: 'mouseForward', group: 'mouse', label: '進むボタン', button: 4 },
    { type: 'mouseRight', group: 'mouse', label: '右クリック', button: 1 },
    { type: 'playPause', group: 'media', label: '再生／一時停止', media: 16 },
    { type: 'nextTrack', group: 'media', label: '次の曲', media: 17 },
    { type: 'prevTrack', group: 'media', label: '前の曲', media: 18 },
    { type: 'volumeUp', group: 'media', label: '音量を上げる', media: 0 },
    { type: 'volumeDown', group: 'media', label: '音量を下げる', media: 1 },
    { type: 'mute', group: 'media', label: '消音', media: 7 },
    { type: 'openHistory', group: 'clipshelf', label: 'クリップボード履歴を開く' },
    { type: 'toggleShelf', group: 'clipshelf', label: 'シェルフを表示／隠す' },
    { type: 'screenOcr', group: 'clipshelf', label: '画面から文字を読み取る' },
    { type: 'toggleKeepAwake', group: 'clipshelf', label: 'スリープ防止 ON／OFF' },
    { type: 'snap', group: 'clipshelf', label: 'ウィンドウを整列', param: 'layout' },
    { type: 'openApp', group: 'open', label: 'アプリを開く', param: 'target' },
    { type: 'openUrl', group: 'open', label: 'Webページ／ファイルを開く', param: 'target' },
    { type: 'none', group: 'other', label: '何もしない（ボタンを無効にする）' }
  ];
  const ACTION_BY_TYPE = Object.fromEntries(ACTIONS.map((a) => [a.type, a]));

  function actionLabel(action, platform, extra = {}) {
    if (!action) return '標準の動作';
    const def = ACTION_BY_TYPE[action.type];
    if (!def) return '標準の動作';
    const base = platform !== 'darwin' && def.winLabel ? def.winLabel : def.label;
    switch (action.type) {
      case 'desktop':
        return `デスクトップ ${action.n} へ移動`;
      case 'shortcut':
        return action.accelerator && extra.accDisplay ? `キー: ${extra.accDisplay(action.accelerator)}` : `キー: ${action.accelerator || '未設定'}`;
      case 'snap':
        return `整列: ${(extra.snapLabels && extra.snapLabels[action.layout]) || action.layout}`;
      case 'openApp':
        return `開く: ${action.label || baseName(action.target)}`;
      case 'openUrl':
        return `開く: ${action.label || action.target}`;
      default:
        return base;
    }
  }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).pop().replace(/\.(app|exe|lnk)$/i, '') || '（未設定）';
  }

  // Returns a clean action or null (= "標準の動作" / not assigned).
  function normalizeAction(a, { snapActions = null } = {}) {
    if (!a || typeof a !== 'object') return null;
    const def = ACTION_BY_TYPE[a.type];
    if (!def) return null;
    const out = { type: a.type };
    if (a.type === 'desktop') {
      const n = Math.round(Number(a.n));
      if (!(n >= 1 && n <= 16)) return null;
      out.n = n;
    } else if (a.type === 'shortcut') {
      if (typeof a.accelerator !== 'string' || !a.accelerator || a.accelerator.length > 60) return null;
      out.accelerator = a.accelerator;
    } else if (a.type === 'snap') {
      if (typeof a.layout !== 'string' || (snapActions && !snapActions.includes(a.layout))) return null;
      out.layout = a.layout;
    } else if (a.type === 'openApp' || a.type === 'openUrl') {
      if (typeof a.target !== 'string' || !a.target.trim() || a.target.length > 2000) return null;
      out.target = a.target.trim();
      if (typeof a.label === 'string' && a.label.trim()) out.label = a.label.trim().slice(0, 80);
    }
    return out;
  }

  function normalizeBindings(raw, opts) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, action] of Object.entries(raw)) {
      if (!isValidKey(key)) continue;
      // per-app: {type:'inherit'} is stored as "absent"; {type:'default'} = force the OS behaviour
      if (action && action.type === 'default') {
        if (opts && opts.allowDefault) out[key] = { type: 'default' };
        continue;
      }
      const clean = normalizeAction(action, opts);
      if (clean) out[key] = clean;
    }
    return out;
  }

  const DEFAULTS = {
    enabled: false,
    holdMs: 450,
    gestureDistance: 40,
    scrollCooldownMs: 250,
    // 「ホイールボタンを押しながらスクロールでデスクトップ移動」を最初から入れておく
    bindings: {
      'middle.scrollUp': { type: 'spaceLeft' },
      'middle.scrollDown': { type: 'spaceRight' }
    },
    extraButtons: [],
    apps: []
  };

  function clamp(v, lo, hi, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
  }

  function normalize(raw, opts = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
      holdMs: clamp(r.holdMs, 200, 2000, DEFAULTS.holdMs),
      gestureDistance: clamp(r.gestureDistance, 15, 300, DEFAULTS.gestureDistance),
      scrollCooldownMs: clamp(r.scrollCooldownMs, 0, 2000, DEFAULTS.scrollCooldownMs),
      bindings: r.bindings === undefined ? JSON.parse(JSON.stringify(DEFAULTS.bindings)) : normalizeBindings(r.bindings, opts),
      extraButtons: Array.isArray(r.extraButtons) ? [...new Set(r.extraButtons.filter((b) => EXTRA_BUTTON_RE.test(b)))].sort(sortButtons) : [],
      apps: []
    };
    const seen = new Set();
    for (const app of Array.isArray(r.apps) ? r.apps : []) {
      if (!app || typeof app !== 'object' || typeof app.id !== 'string' || !app.id.trim()) continue;
      const id = app.id.trim().slice(0, 200);
      if (seen.has(id)) continue;
      seen.add(id);
      const name = typeof app.name === 'string' && app.name.trim() ? app.name.trim().slice(0, 80) : id;
      out.apps.push({ id, name, bindings: normalizeBindings(app.bindings, { ...opts, allowDefault: true }) });
      if (out.apps.length >= 50) break;
    }
    return out;
  }

  function sortButtons(a, b) {
    return Number(a.slice(1)) - Number(b.slice(1));
  }

  // ------------------------------------------------------------ resolution
  function appProfile(mouse, appId) {
    return (mouse.apps || []).find((a) => a.id === appId) || null;
  }

  // The action to run for `key` in app `appId`, or null (= leave it to the OS).
  function resolve(mouse, appId, key) {
    const app = appId ? appProfile(mouse, appId) : null;
    if (app && app.bindings[key]) return app.bindings[key].type === 'default' ? null : app.bindings[key];
    return mouse.bindings[key] || null;
  }

  function effectiveKeys(mouse, appId) {
    const keys = new Set(Object.keys(mouse.bindings || {}));
    const app = appId ? appProfile(mouse, appId) : null;
    if (app) {
      for (const [k, a] of Object.entries(app.bindings)) {
        if (a.type === 'default') keys.delete(k);
        else keys.add(k);
      }
    }
    return [...keys].filter(isValidKey).sort();
  }

  // → { '': [...], '<bundle id>': [...] } for the native engine.
  function profiles(mouse) {
    const out = { '': effectiveKeys(mouse, null) };
    for (const app of mouse.apps || []) out[app.id] = effectiveKeys(mouse, app.id);
    return out;
  }

  // ------------------------------------------------------------ keys
  // US-ANSI virtual key codes (kVK_*) — positions, so they also work with a JIS keyboard.
  const MAC_KEYCODES = {
    A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
    1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, O: 31, U: 32,
    '[': 33, I: 34, P: 35, Return: 36, L: 37, J: 38, "'": 39, K: 40, ';': 41, '\\': 42, ',': 43, '/': 44, N: 45,
    M: 46, '.': 47, Tab: 48, Space: 49, '`': 50, Backspace: 51, Escape: 53,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
    F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
    Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121, Left: 123, Right: 124, Down: 125, Up: 126, Insert: 114,
    num0: 82, num1: 83, num2: 84, num3: 85, num4: 86, num5: 87, num6: 88, num7: 89, num8: 91, num9: 92
  };
  const MOD_BITS = { Control: 1, Option: 2, Alt: 2, Shift: 4, Command: 8, Super: 8, Meta: 8, CommandOrControl: 8 };

  // "Command+Shift+W" → { code: 13, mods: 12 } (macOS) or null.
  function macKey(accelerator) {
    if (typeof accelerator !== 'string' || !accelerator) return null;
    const parts = accelerator.split('+');
    const key = parts.pop();
    let mods = 0;
    for (const m of parts) {
      if (!(m in MOD_BITS)) return null;
      mods |= MOD_BITS[m];
    }
    const code = MAC_KEYCODES[key] !== undefined ? MAC_KEYCODES[key] : MAC_KEYCODES[String(key).toUpperCase()];
    return code === undefined ? null : { code, mods };
  }

  // Like accelerator.fromKeyboardEvent, but any key is fine (Esc, PageDown… alone).
  function acceleratorFromEvent(e, platform, keyFromCode) {
    const MODS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn', 'FnLock']);
    const mods = [];
    if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push(platform === 'darwin' ? 'Option' : 'Alt');
    if (e.shiftKey) mods.push('Shift');
    if (MODS.has(e.code)) return { pending: true, modifiers: mods };
    const key = e.code === 'Escape' ? 'Escape' : keyFromCode(e.code);
    if (!key) return { error: 'unsupported' };
    return { accelerator: mods.concat(key).join('+') };
  }

  return {
    BUTTONS, BUTTON_TRIGGERS, WHEEL_TRIGGERS, MOD_PRESETS, GROUPS, ACTIONS, ACTION_BY_TYPE, DEFAULTS, EXTRA_BUTTON_RE,
    buttonLabel, modsLabel, keyLabel, actionLabel, isValidKey, isButtonId, normalize, normalizeAction, resolve,
    effectiveKeys, profiles, macKey, acceleratorFromEvent, MAC_KEYCODES
  };
});
