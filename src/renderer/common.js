'use strict';
/* global ClipShelfAccelerator */
// Small helpers shared by every renderer page (loaded as a classic script).
(function () {
  const api = window.clipshelf;
  const isMac = api.platform === 'darwin';

  const ICONS = {
    text: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h10M3 7h10M3 10h7M3 13h5" stroke-linecap="round"/></svg>',
    url: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" stroke-linecap="round"/></svg>',
    image: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 1.5-1.5L13 12" stroke-linejoin="round"/></svg>',
    file: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2h5l3 3v9H4z" stroke-linejoin="round"/><path d="M9 2v3h3"/></svg>',
    folder: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5h4l1.5 1.5H14v7H2z" stroke-linejoin="round"/></svg>',
    search: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/></svg>',
    clock: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.6" stroke-linecap="round"/></svg>',
    plus: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>',
    more: '<svg class="svg" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
    filter: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke-linecap="round"/></svg>',
    close: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round"/></svg>',
    eye: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    lock: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>',
    unlock: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1"/></svg>',
    check: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8.3l2.6 2.6L12 5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronDown: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 6.5 8 10l3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronLeft: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9.5 4.5 6 8l3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronRight: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 4.5 10 8l-3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    split: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 14V8.5M8 8.5 3.5 4M8 8.5 12.5 4M3.5 4v2.6M3.5 4h2.6M12.5 4v2.6M12.5 4H9.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" stroke-linecap="round"/></svg>',
    broom: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.5 2 7.8 7.2M4 8.2l6 2.9-1.4 3.4c-2.3-.3-4.5-1.4-6-3.3z" stroke-linejoin="round" stroke-linecap="round"/><path d="M5.2 8.8c1.4-1.9 3.4-1.4 5.1-.5"/></svg>',
    drop: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M24 8v20M16 21l8 8 8-8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 30v6.5A2.5 2.5 0 0 0 11.5 39h25a2.5 2.5 0 0 0 2.5-2.5V30" stroke-linecap="round"/></svg>',
    arrowDown: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M4 9l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowUp: '<svg class="svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3M4 7l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pause: '<svg class="svg" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3.5" width="2.6" height="9" rx="0.8"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="0.8"/></svg>'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = ICONS[name] || ICONS.text; // constant markup only
    return span.firstChild;
  }

  function timeAgo(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min}分前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}時間前`;
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d >= yesterday) return '昨日';
    const days = Math.floor(diff / 86400000);
    if (days < 7) return `${days}日前`;
    if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  const HEX_RE = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\s*$/i;
  const RGB_RE = /^\s*rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)\s*$/i;
  function colorOf(text) {
    if (!text || text.length > 40) return null;
    const m = HEX_RE.exec(text);
    if (m && (text.trim().startsWith('#'))) return `#${m[1]}`;
    if (RGB_RE.test(text)) return text.trim();
    return null;
  }

  function typeLabel(item) {
    if (item.type === 'text' && colorOf(item.text)) return 'カラー';
    if (item.type === 'file') {
      const n = (item.files || []).length;
      if (n > 1) return `${n} ファイル`;
      const f = item.files && item.files[0];
      return f && f.isDir ? 'フォルダ' : 'ファイル';
    }
    return { text: 'テキスト', url: 'リンク', image: '画像' }[item.type] || '';
  }

  function hostOf(url) {
    try {
      return new URL(/^www\./i.test(url) ? `https://${url}` : url).host;
    } catch {
      return url;
    }
  }

  let toastTimer = null;
  function toast(text) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  // Modifier name ('Command' | 'Shift' | 'Option' | 'Control') → pressed?
  function modHeld(e, name) {
    if (name === 'Command') return isMac ? e.metaKey : e.ctrlKey;
    if (name === 'Control') return e.ctrlKey;
    if (name === 'Option' || name === 'Alt') return e.altKey;
    if (name === 'Shift') return e.shiftKey;
    return false;
  }

  const MOD_LABEL = isMac
    ? { Command: '⌘', Shift: '⇧', Option: '⌥', Control: '⌃' }
    : { Command: 'Ctrl', Shift: 'Shift', Option: 'Alt', Control: 'Ctrl' };

  function accDisplay(acc) {
    return acc ? ClipShelfAccelerator.toDisplay(acc, api.platform) : '';
  }

  const composing = (e) => e.isComposing || e.keyCode === 229;

  window.CS = { api, isMac, ICONS, el, icon, timeAgo, formatBytes, colorOf, typeLabel, hostOf, toast, modHeld, MOD_LABEL, accDisplay, composing };
})();
