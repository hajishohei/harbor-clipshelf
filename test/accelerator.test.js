'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/shared/accelerator');

const ev = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('builds mac accelerators with Command/Option names', () => {
  assert.deepEqual(A.fromKeyboardEvent(ev('KeyV', { metaKey: true, shiftKey: true }), 'darwin'), { accelerator: 'Command+Shift+V' });
  assert.deepEqual(A.fromKeyboardEvent(ev('ArrowLeft', { ctrlKey: true, altKey: true }), 'darwin'), { accelerator: 'Control+Option+Left' });
});

test('builds windows accelerators with Alt/Super names', () => {
  assert.deepEqual(A.fromKeyboardEvent(ev('Digit2', { ctrlKey: true, shiftKey: true }), 'win32'), { accelerator: 'Control+Shift+2' });
  assert.deepEqual(A.fromKeyboardEvent(ev('Enter', { ctrlKey: true, altKey: true }), 'win32'), { accelerator: 'Control+Alt+Return' });
  assert.deepEqual(A.fromKeyboardEvent(ev('KeyK', { metaKey: true }), 'win32'), { accelerator: 'Super+K' });
});

test('modifier-only presses are pending, bare keys need a modifier', () => {
  assert.equal(A.fromKeyboardEvent(ev('ShiftLeft', { shiftKey: true }), 'darwin').pending, true);
  assert.equal(A.fromKeyboardEvent(ev('CapsLock'), 'darwin').pending, true);
  assert.equal(A.fromKeyboardEvent(ev('KeyA'), 'darwin').error, 'needs-modifier');
  assert.equal(A.fromKeyboardEvent(ev('KeyA', { shiftKey: true }), 'darwin').error, 'needs-modifier');
  assert.deepEqual(A.fromKeyboardEvent(ev('F5'), 'darwin'), { accelerator: 'F5' });
});

test('escape cancels and backspace clears when pressed alone', () => {
  assert.equal(A.fromKeyboardEvent(ev('Escape'), 'darwin').cancel, true);
  assert.equal(A.fromKeyboardEvent(ev('Backspace'), 'darwin').clear, true);
  assert.deepEqual(A.fromKeyboardEvent(ev('Backspace', { ctrlKey: true, altKey: true }), 'darwin'), { accelerator: 'Control+Option+Backspace' });
});

test('unsupported keys are reported', () => {
  assert.equal(A.fromKeyboardEvent(ev('MediaPlayPause', { ctrlKey: true }), 'win32').error, 'unsupported');
});

test('display strings', () => {
  assert.equal(A.toDisplay('Command+Shift+V', 'darwin'), '⇧⌘V');
  assert.equal(A.toDisplay('Control+Option+Left', 'darwin'), '⌃⌥←');
  assert.equal(A.toDisplay('Control+Alt+Return', 'win32'), 'Ctrl+Alt+↩');
  assert.equal(A.toDisplay('', 'win32'), '');
});

test('every default shortcut uses keys the recorder can produce', () => {
  const recordable = new Set(['Left', 'Right', 'Up', 'Down', 'Return', 'Backspace']);
  for (const acc of Object.values(require('../src/main/settings').DEFAULT_SHORTCUTS).filter(Boolean)) {
    const key = acc.split('+').pop();
    assert.ok(recordable.has(key) || /^[A-Z0-9]$/.test(key), acc);
  }
});
