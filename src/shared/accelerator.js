/* Shared by the main process (require) and renderer (<script>): converts
 * keyboard events into Electron accelerator strings and back into labels. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipShelfAccelerator = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CODE_MAP = {
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Enter: 'Return', NumpadEnter: 'Return', Space: 'Space', Backspace: 'Backspace',
    Delete: 'Delete', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp',
    PageDown: 'PageDown', Insert: 'Insert', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
    Period: '.', Slash: '/', Backquote: '`', IntlYen: '\\', IntlRo: '\\'
  };
  const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn', 'FnLock'
  ]);

  function keyFromCode(code) {
    if (typeof code !== 'string') return null;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return CODE_MAP[code] || null;
  }

  // Returns { accelerator } | { pending: true } (only modifiers held so far)
  // | { cancel: true } | { clear: true } | { error: 'unsupported'|'needs-modifier' }
  function fromKeyboardEvent(e, platform) {
    const mods = [];
    if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push(platform === 'darwin' ? 'Option' : 'Alt');
    if (e.shiftKey) mods.push('Shift');
    if (MODIFIER_CODES.has(e.code)) return { pending: true, modifiers: mods };
    if (!mods.length && e.code === 'Escape') return { cancel: true };
    if (!mods.length && (e.code === 'Backspace' || e.code === 'Delete')) return { clear: true };
    const key = e.code === 'Escape' ? 'Escape' : keyFromCode(e.code);
    if (!key) return { error: 'unsupported' };
    const isFunctionKey = /^F\d+$/.test(key);
    const onlyShift = mods.length === 1 && mods[0] === 'Shift';
    if (!isFunctionKey && (mods.length === 0 || onlyShift)) return { error: 'needs-modifier' };
    return { accelerator: mods.concat(key).join('+') };
  }

  const MAC_SYMBOLS = { Command: '⌘', Control: '⌃', Option: '⌥', Alt: '⌥', Shift: '⇧', Super: '⌘' };
  const KEY_LABELS = { Left: '←', Right: '→', Up: '↑', Down: '↓', Return: '↩', Backspace: '⌫', Delete: '⌦', Space: 'Space', Escape: 'Esc' };
  const MAC_ORDER = ['Control', 'Option', 'Alt', 'Shift', 'Command', 'Super'];

  function toDisplay(accelerator, platform) {
    if (!accelerator) return '';
    const parts = String(accelerator).split('+').filter(Boolean);
    const key = parts.pop();
    const keyLabel = KEY_LABELS[key] || (key.startsWith('num') ? 'Num' + key.slice(3) : key);
    if (platform === 'darwin') {
      const mods = parts.slice().sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
      return mods.map((m) => MAC_SYMBOLS[m] || m).join('') + keyLabel;
    }
    const names = { Control: 'Ctrl', CommandOrControl: 'Ctrl', Super: 'Win', Option: 'Alt' };
    return parts.map((m) => names[m] || m).concat(keyLabel).join('+');
  }

  return { keyFromCode, fromKeyboardEvent, toDisplay };
});
