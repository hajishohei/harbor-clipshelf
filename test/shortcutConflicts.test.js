'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runningKnownApps, explain, ShortcutConflicts } = require('../src/main/shortcutConflicts');

const PS = [
  '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
  '/Applications/Paste.app/Contents/MacOS/Paste',
  '/Applications/Paste.app/Contents/Library/LoginItems/Paste Helper.app/Contents/MacOS/Paste Helper',
  '/Applications/Magnet.app/Contents/MacOS/Magnet'
].join('\n');

test('finds the original apps that hold our shortcuts', () => {
  const names = runningKnownApps(PS).map((a) => a.name);
  assert.deepEqual(names, ['Paste', 'Magnet']);
  const list = explain({
    togglePanel: { accelerator: 'Command+Shift+V', registered: false, reason: 'in-use' },
    toggleShelf: { accelerator: 'F5', registered: true },
    snapLeft: { accelerator: 'Control+Alt+Left', registered: false, reason: 'in-use' },
    screenOcr: { accelerator: 'Command+Shift+2', registered: false, reason: 'in-use' },
    toggleKeepAwake: { accelerator: '', registered: false, reason: 'empty' }
  }, runningKnownApps(PS));
  assert.deepEqual(list.map((c) => [c.key, c.app && c.app.name]), [['togglePanel', 'Paste'], ['snapLeft', 'Magnet'], ['screenOcr', null]]);
});

test('retries while a shortcut is taken and tells the user once', async () => {
  let registered = false;
  const results = () => ({ togglePanel: { accelerator: 'Command+Shift+V', registered, reason: registered ? null : 'in-use' } });
  const shortcuts = { status: () => ({ results: results() }) };
  const shown = [];
  const changes = [];
  const c = new ShortcutConflicts({
    shortcuts,
    reapply: () => results(),
    hud: { show: (title, body) => shown.push(title + body) },
    log: { warn() {} },
    onChange: (l) => changes.push(l.length),
    platform: 'linux'
  });
  await c.check();
  await c.check({ retry: true });
  assert.equal(c.current().length, 1);
  assert.equal(shown.length, 1);
  registered = true; // the other app quit
  await c.check({ retry: true });
  assert.equal(c.current().length, 0);
  assert.deepEqual(changes, [1, 0]);
});
