'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const M = require('../src/shared/mouseBindings');
const S = require('../src/main/settings');

test('fresh settings: mouse control is off, wheel button + wheel switches desktops once turned on', () => {
  const s = S.normalize({});
  assert.equal(s.mouse.enabled, false);
  assert.deepEqual(s.mouse.bindings['middle.scrollUp'], { type: 'spaceLeft' });
  assert.deepEqual(s.mouse.bindings['middle.scrollDown'], { type: 'spaceRight' });
  assert.equal(s.shortcuts.toggleMouse, '');
});

test('normalize drops unknown triggers / actions and clamps numbers', () => {
  const m = M.normalize({
    enabled: true,
    holdMs: 10,
    scrollCooldownMs: 99999,
    bindings: {
      'middle.click': { type: 'missionControl' },
      'left.click': { type: 'mute' }, // left button can't be taken over
      'back.fly': { type: 'mute' },
      'b5.click': { type: 'desktop', n: 3 },
      'b5.hold': { type: 'desktop', n: 99 },
      'alt+cmd.scrollUp': { type: 'volumeUp' },
      'cmd+alt.scrollUp': { type: 'volumeUp' }, // wrong order
      'forward.click': { type: 'shortcut', accelerator: 'Command+W' },
      'forward.hold': { type: 'shortcut', accelerator: '' },
      tiltLeft: { type: 'snap', layout: 'snapLeft' },
      tiltRight: { type: 'rm -rf' }
    },
    extraButtons: ['b5', 'b5', 'b2', 'b9'],
    apps: [{ id: 'com.google.Chrome', name: 'Chrome', bindings: { 'middle.click': { type: 'default' }, 'back.click': { type: 'inherit' } } }, { id: '' }]
  }, { snapActions: ['snapLeft'] });
  assert.equal(m.holdMs, 200);
  assert.equal(m.scrollCooldownMs, 2000);
  assert.deepEqual(Object.keys(m.bindings).sort(), ['alt+cmd.scrollUp', 'b5.click', 'forward.click', 'middle.click', 'tiltLeft']);
  assert.deepEqual(m.extraButtons, ['b5', 'b9']);
  assert.equal(m.apps.length, 1);
  assert.deepEqual(m.apps[0].bindings, { 'middle.click': { type: 'default' } });
});

test('per-app profiles: override, inherit, and back to the OS default', () => {
  const m = M.normalize({
    enabled: true,
    bindings: { 'middle.click': { type: 'missionControl' }, 'back.click': { type: 'spaceLeft' } },
    apps: [{ id: 'com.google.Chrome', name: 'Chrome', bindings: { 'back.click': { type: 'default' }, 'forward.click': { type: 'shortcut', accelerator: 'Command+T' } } }]
  });
  assert.deepEqual(M.profiles(m), {
    '': ['back.click', 'middle.click'],
    'com.google.Chrome': ['forward.click', 'middle.click']
  });
  assert.equal(M.resolve(m, 'com.google.Chrome', 'back.click'), null);
  assert.equal(M.resolve(m, 'com.google.Chrome', 'middle.click').type, 'missionControl');
  assert.equal(M.resolve(m, 'com.apple.finder', 'back.click').type, 'spaceLeft');
  assert.equal(M.resolve(m, '', 'forward.click'), null);
});

test('accelerators map to macOS key codes', () => {
  assert.deepEqual(M.macKey('Command+Shift+W'), { code: 13, mods: 12 });
  assert.deepEqual(M.macKey('Control+Left'), { code: 123, mods: 1 });
  assert.deepEqual(M.macKey('Escape'), { code: 53, mods: 0 });
  assert.deepEqual(M.macKey('Option+3'), { code: 20, mods: 2 });
  assert.equal(M.macKey('Hyper+Q'), null);
  assert.equal(M.macKey('Command+NoSuchKey'), null);
});

test('labels read naturally', () => {
  assert.equal(M.keyLabel('middle.scrollDown', 'darwin'), 'ホイールボタン（押し込み）：押しながらホイールを下へ');
  assert.equal(M.keyLabel('alt+cmd.scrollUp', 'darwin'), '⌥⌘ を押しながらホイールを上へ');
  assert.equal(M.keyLabel('b5.click', 'darwin'), 'ボタン6：クリック');
  assert.equal(M.actionLabel({ type: 'desktop', n: 2 }, 'darwin'), 'デスクトップ 2 へ移動');
  assert.equal(M.actionLabel(null, 'darwin'), '標準の動作');
});

// ---------------------------------------------------------------- MouseControl with a fake native module
function loadMouseControl() {
  const electronStub = { shell: { openPath: async () => '', openExternal: async () => {} } };
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return orig.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/main/mouseControl')];
    return require('../src/main/mouseControl');
  } finally {
    Module._load = orig;
  }
}

function fakeNative({ startError = null } = {}) {
  const calls = [];
  return {
    calls,
    cb: null,
    start(cb) {
      calls.push(['start']);
      if (startError) throw new Error(startError);
      this.cb = cb;
      return true;
    },
    stop() {
      calls.push(['stop']);
    },
    configure(c) {
      calls.push(['configure', c]);
    },
    setObserve(on) {
      calls.push(['observe', on]);
    },
    postKey(code, mods) {
      calls.push(['key', code, mods]);
    },
    postHotKey(id) {
      calls.push(['hotkey', id]);
    },
    postMedia(code) {
      calls.push(['media', code]);
    },
    click(b) {
      calls.push(['click', b]);
    }
  };
}

const quietLog = { info() {}, warn() {}, error() {} };
const hud = { show() {} };

test('MouseControl runs the action assigned for the front app', async () => {
  const { MouseControl } = loadMouseControl();
  let settings = S.normalize({ mouse: { enabled: true, bindings: { 'middle.scrollDown': { type: 'spaceRight' }, 'back.click': { type: 'mute' } }, apps: [{ id: 'app.x', name: 'X', bindings: { 'back.click': { type: 'shortcut', accelerator: 'Command+W' } } }] } });
  const native = fakeNative();
  const mc = new MouseControl({ getSettings: () => settings, features: {}, hud, log: quietLog, native, platform: 'darwin' });
  mc.apply();
  assert.equal(mc.status().running, true);
  const cfg = native.calls.find((c) => c[0] === 'configure')[1];
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.profiles[''], ['back.click', 'middle.scrollDown']);
  native.cb({ type: 'trigger', key: 'middle.scrollDown', app: 'com.apple.finder' });
  native.cb({ type: 'trigger', key: 'back.click', app: 'com.apple.finder' });
  native.cb({ type: 'trigger', key: 'back.click', app: 'app.x' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(native.calls.filter((c) => ['hotkey', 'media', 'key'].includes(c[0])), [['hotkey', 81], ['media', 7], ['key', 13, 8]]);

  mc.togglePause();
  assert.equal(native.calls.filter((c) => c[0] === 'configure').pop()[1].enabled, false);
  settings = S.merge(settings, { mouse: { ...settings.mouse, enabled: false } });
  mc.apply();
  assert.equal(mc.status().running, false);
});

test('MouseControl reports a missing permission instead of failing', () => {
  const { MouseControl } = loadMouseControl();
  const settings = S.normalize({ mouse: { enabled: true } });
  const mc = new MouseControl({ getSettings: () => settings, features: {}, hud, log: quietLog, native: fakeNative({ startError: 'accessibility' }), platform: 'darwin' });
  const st = mc.apply();
  assert.equal(st.running, false);
  assert.equal(st.error, 'accessibility');
});

test('MouseControl stays off where it is not supported yet', () => {
  const { MouseControl } = loadMouseControl();
  const settings = S.normalize({ mouse: { enabled: true } });
  const native = fakeNative();
  const mc = new MouseControl({ getSettings: () => settings, features: {}, hud, log: quietLog, native, platform: 'win32' });
  const st = mc.apply();
  assert.equal(st.running, false);
  assert.equal(st.supported, false);
  assert.equal(native.calls.length, 0);
});
