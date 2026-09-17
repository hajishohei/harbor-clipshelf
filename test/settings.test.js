'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/main/settings');

test('normalize fills defaults and clamps values', () => {
  const s = S.normalize({ version: 3, shelfPosition: 'top', keepAwake: { mode: 'weird' }, focusFollowMouse: { delayMs: 99999 }, historyRetention: 'decade', panelHeight: 5, pasteTarget: 'x', ignoredApps: ['  A  ', '', 3] });
  assert.equal(s.shelfPosition, 'left-center');
  assert.equal(s.historyRetention, 'month');
  assert.equal(s.pasteTarget, 'app');
  assert.equal(s.panelHeight, 120);
  assert.deepEqual(s.ignoredApps, ['A', '3']);
  assert.equal(s.keepAwake.mode, 'system');
  assert.equal(s.keepAwake.enabled, false);
  assert.equal(s.focusFollowMouse.delayMs, 3000);
  assert.ok(s.shortcuts.snapLeftThird);
  assert.equal(s.version, 4);
});

test('fresh settings follow Paste / Yoink defaults and record passwords', () => {
  const s = S.normalize({});
  assert.equal(s.ignoreConfidential, false);
  assert.equal(s.ignoreTransient, true);
  assert.deepEqual(s.ignoredApps, []);
  assert.equal(s.historyRetention, 'month');
  assert.equal(s.pasteTarget, 'app');
  assert.equal(s.shelfShowMode, 'dragStart');
  assert.equal(s.shelfFileMode, 'reference');
  assert.equal(s.shelfRemoveAfterDragOut, true);
  assert.ok(s.shortcuts.togglePanel.endsWith('+Shift+V'));
  assert.equal(s.shortcuts.pasteStack, '', 'Paste Stack does not pop up from a shortcut');
  assert.equal(s.shelfCollapseWhenIdle, true);
  assert.equal(s.shelfFollowActiveDisplay, true);
  assert.equal(s.shelfParkSide, 'right');
});

test('v3 settings: the old Paste Stack default is turned off, custom keys stay', () => {
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  assert.equal(S.normalize({ version: 3, shortcuts: { pasteStack: `${mod}+Shift+C` } }).shortcuts.pasteStack, '');
  assert.equal(S.normalize({ version: 3, shortcuts: { pasteStack: 'Control+Alt+P' } }).shortcuts.pasteStack, 'Control+Alt+P');
  assert.equal(S.normalize({ version: 4, shortcuts: { pasteStack: `${mod}+Shift+C` } }).shortcuts.pasteStack, `${mod}+Shift+C`);
  assert.equal(S.normalize({ version: 3, shelfParkSide: 'nowhere' }).shelfParkSide, 'right');
});

test('v1 settings are migrated', () => {
  const s = S.normalize({ keepAwakeEnabled: true, shelfAutoHide: false, shortcuts: { toggleKeepAwake: 'Capslock', toggleShelf: 'Command+Shift+K' } });
  assert.equal(s.keepAwake.enabled, true);
  assert.equal(s.keepAwake.followCapsLock, true);
  assert.equal(s.shortcuts.toggleKeepAwake, '');
  assert.equal(s.shortcuts.toggleShelf, 'Command+Shift+K');
  assert.ok(!('keepAwakeEnabled' in s));
  assert.ok(!('shelfAutoHide' in s));
});

test('v2 settings are migrated to the Paste / Yoink model', () => {
  const s = S.normalize({
    version: 2,
    skipSensitive: true,
    excludedApps: ['1Password', 'Bitwarden', 'Slack'],
    historyLimit: 500,
    shelfEdge: 'right',
    shelfEnabled: false,
    closeAfterClickCopy: true,
    mainBounds: { x: 1 },
    shortcuts: { toggleHistory: 'Control+Alt+V', snapLeft: 'Control+Alt+H', bogus: 'X' }
  });
  assert.equal(s.ignoreConfidential, false, 'passwords are recorded now');
  assert.deepEqual(s.ignoredApps, ['Slack'], 'old default password managers removed, own entries kept');
  assert.equal(s.shortcuts.togglePanel, 'Control+Alt+V');
  assert.equal(s.shortcuts.snapLeft, 'Control+Alt+H');
  assert.ok(!('toggleHistory' in s.shortcuts));
  assert.ok(!('bogus' in s.shortcuts));
  assert.equal(s.shelfPosition, 'right-center');
  assert.equal(s.shelfEnabled, false);
  assert.equal(s.historyRetention, 'forever', 'upgrading never deletes history');
  for (const k of ['skipSensitive', 'excludedApps', 'historyLimit', 'shelfEdge', 'closeAfterClickCopy', 'mainBounds']) assert.ok(!(k in s), k);
});

test('retention periods', () => {
  assert.equal(S.RETENTION_MS.forever, Infinity);
  assert.ok(S.RETENTION_MS.day < S.RETENTION_MS.week && S.RETENTION_MS.week < S.RETENTION_MS.month && S.RETENTION_MS.month < S.RETENTION_MS.year);
});

test('merge is deep for nested groups and does not mutate', () => {
  const base = S.normalize({});
  const next = S.merge(base, { keepAwake: { followCapsLock: true }, shortcuts: { snapLeft: 'Control+Alt+H' } });
  assert.equal(next.keepAwake.followCapsLock, true);
  assert.equal(next.keepAwake.mode, 'system');
  assert.equal(next.shortcuts.snapLeft, 'Control+Alt+H');
  assert.equal(next.shortcuts.snapRight, base.shortcuts.snapRight);
  assert.equal(base.keepAwake.followCapsLock, false);
});

test('default shortcuts are unique', () => {
  const values = Object.entries(S.DEFAULT_SHORTCUTS).filter(([k, v]) => v && !S.LOCAL_SHORTCUTS.includes(k)).map(([, v]) => v);
  assert.equal(new Set(values).size, values.length);
});
