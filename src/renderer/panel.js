'use strict';
/* global CS */
// Paste-style clipboard panel.
(function () {
  const { api, isMac, el, icon, timeAgo, formatBytes, colorOf, typeLabel, hostOf, toast, modHeld, composing } = CS;
  const HISTORY = 'history';
  const PAGE = 60;
  const COMPACT_BELOW = 220;
  const TYPE_WORDS = {
    text: ['テキスト', 'text'], url: ['リンク', 'link', 'url'], image: ['画像', 'image', 'img'], file: ['ファイル', 'file', 'files']
  };
  const DATE_FILTERS = [['today', '今日'], ['yesterday', '昨日'], ['week', '過去7日間'], ['month', '過去30日間']];
  const TYPE_FILTERS = [['text', 'テキスト'], ['url', 'リンク'], ['image', '画像'], ['file', 'ファイル']];

  const $ = (id) => document.getElementById(id);
  let modalOpen = false;
  const setModal = (open) => {
    if (modalOpen === open) return;
    modalOpen = open;
    api.setPanelModal(open);
  };
  const panelEl = $('panel');
  const cardsEl = $('cards');
  const searchEl = $('search');
  const searchBox = $('searchBox');

  const state = {
    info: null,
    settings: null,
    pinboards: [],
    boardId: HISTORY,
    history: [],
    pins: [],
    query: '',
    filters: { types: new Set(), apps: new Set(), date: null },
    selected: [],
    anchor: null,
    limit: PAGE,
    thumbs: new Map(),
    fileStatus: {},
    editing: null, // { id, kind: 'rename' | 'edit' | 'new' }
    open: false,
    targetApp: null,
    renderQueued: false,
    dragIds: null,
    paused: false
  };

  // ------------------------------------------------------------------ data
  function listFor(boardId) {
    if (boardId === HISTORY) return state.history;
    const def = state.info && state.info.defaultPinboardId;
    return state.pins.filter((i) => (i.pinboardId || def) === boardId);
  }

  function upsert(item) {
    for (const key of ['history', 'pins']) {
      const arr = state[key];
      const idx = arr.findIndex((i) => i.id === item.id);
      if (idx >= 0) arr.splice(idx, 1);
    }
    if (item.deleted) return;
    if (item.board === 'history') {
      state.history.push(item);
      state.history.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    } else if (item.board === 'pin') {
      state.pins.push(item);
      sortPins();
    } else if (item.board === 'meta' && item.type === 'pinboard') {
      loadPinboards();
    }
  }

  function sortPins() {
    const ord = (i) => (Number.isFinite(i.order) ? i.order : -1);
    state.pins.sort((a, b) => ord(a) - ord(b) || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function removeLocal(id) {
    state.history = state.history.filter((i) => i.id !== id);
    state.pins = state.pins.filter((i) => i.id !== id);
    state.selected = state.selected.filter((x) => x !== id);
    if (state.pinboards.some((b) => b.id === id)) loadPinboards();
  }

  async function loadPinboards() {
    state.pinboards = await api.listPinboards();
    if (state.boardId !== HISTORY && !state.pinboards.some((b) => b.id === state.boardId)) state.boardId = HISTORY;
    renderBoards();
  }

  async function loadAll() {
    const [history, pins] = await Promise.all([api.listItems('history'), api.listItems('pin')]);
    state.history = history;
    state.pins = pins;
    sortPins();
    await loadPinboards();
    scheduleRender();
  }

  // ------------------------------------------------------------------ filtering
  function startOfDay(offset = 0) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
  }

  function matchesDate(item) {
    const t = item.usedAt || item.createdAt || 0;
    switch (state.filters.date) {
      case 'today': return t >= startOfDay(0);
      case 'yesterday': return t >= startOfDay(-1) && t < startOfDay(0);
      case 'week': return t >= Date.now() - 7 * 86400000;
      case 'month': return t >= Date.now() - 30 * 86400000;
      default: return true;
    }
  }

  function haystack(item) {
    return [
      item.label, item.text, item.preview, item.ocrText, item.sourceApp, item.linkTitle,
      ...(item.files || []).map((f) => f.name), typeLabel(item)
    ].filter(Boolean).join('\n').toLowerCase();
  }

  function parsedQuery() {
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const types = new Set(state.filters.types);
    const rest = [];
    for (const w of words) {
      const t = Object.entries(TYPE_WORDS).find(([, list]) => list.includes(w));
      if (t) types.add(t[0]);
      else rest.push(w);
    }
    return { types, words: rest };
  }

  function visibleItems() {
    const { types, words } = parsedQuery();
    const apps = state.filters.apps;
    return listFor(state.boardId).filter((item) => {
      if (types.size && !types.has(item.type)) return false;
      if (apps.size && !apps.has(item.sourceApp || '')) return false;
      if (!matchesDate(item)) return false;
      if (!words.length) return true;
      const hay = haystack(item);
      return words.every((w) => hay.includes(w));
    });
  }

  // ------------------------------------------------------------------ rendering
  // While something is being typed in a card, a rebuild would throw the text
  // away: remember that a refresh is due and do it when editing ends.
  function editingInCards() {
    return !!(state.editing && ['edit', 'new', 'rename'].includes(state.editing.kind));
  }

  function scheduleRender({ force = false } = {}) {
    if (editingInCards() && !force) {
      state.renderDeferred = true;
      return;
    }
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      render();
    });
  }

  function render() {
    state.renderDeferred = false;
    panelEl.classList.toggle('compact', window.innerHeight < COMPACT_BELOW);
    renderBoards();
    renderTokens();
    renderPaused();
    const items = visibleItems();
    const ids = new Set(items.map((i) => i.id));
    state.selected = state.selected.filter((id) => ids.has(id));
    if (!state.selected.length && items.length && state.editing?.kind !== 'new') state.selected = [items[0].id];

    const scroll = cardsEl.scrollLeft;
    const nodes = [];
    if (state.editing && state.editing.kind === 'new') nodes.push(newItemCard());
    items.slice(0, state.limit).forEach((item, i) => nodes.push(card(item, i)));
    if (items.length > state.limit) nodes.push(el('div', 'more-hint', `…ほか ${items.length - state.limit} 件`));
    cardsEl.replaceChildren(...nodes);
    cardsEl.scrollLeft = scroll;

    const empty = $('empty');
    empty.hidden = items.length > 0 || !!state.editing;
    if (!empty.hidden) {
      const filtered = state.query || state.filters.types.size || state.filters.apps.size || state.filters.date;
      empty.replaceChildren(
        el('strong', null, filtered ? '何も見つかりません' : state.boardId === HISTORY ? '履歴はありません' : 'ピンボードが空です'),
        el('span', null, filtered ? '検索語やフィルタを変えてみてください' : state.boardId === HISTORY ? 'コピーしたものがここに並びます' : 'アイテムをドラッグするか、右クリック →「固定」で追加できます')
      );
    }
    updateSelection();
    requestFileStatus(items.slice(0, state.limit));
  }

  function renderBoards() {
    const box = $('boards');
    const nodes = [];
    const tab = (id, label, color) => {
      const b = el('button', `board${color ? ` color-${color}` : ''}`);
      b.type = 'button';
      b.dataset.id = id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.boardId === id));
      if (id === HISTORY) b.append(icon('clock'));
      else b.append(el('span', 'dot'));
      if (state.editing && state.editing.kind === 'pinboard' && state.editing.id === id) {
        const input = el('input');
        input.value = label;
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (composing(e)) return;
          if (e.key === 'Enter') finishPinboardRename(id, input.value);
          if (e.key === 'Escape') finishPinboardRename(id, null);
        });
        input.addEventListener('blur', () => finishPinboardRename(id, input.value));
        input.addEventListener('dblclick', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        b.append(input);
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      } else {
        b.append(el('span', null, label));
      }
      b.addEventListener('click', () => switchBoard(id));
      b.addEventListener('dblclick', () => id !== HISTORY && startPinboardRename(id));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        pinboardMenu(id === HISTORY ? null : id);
      });
      // drop cards onto a pinboard to pin them
      b.addEventListener('dragover', (e) => {
        const internal = Array.from(e.dataTransfer.types).includes('application/x-clipshelf-item');
        const boardDrag = Array.from(e.dataTransfer.types).includes('application/x-clipshelf-board');
        if ((internal && id !== HISTORY) || (boardDrag && id !== HISTORY)) {
          e.preventDefault();
          b.classList.add('drop');
        }
      });
      b.addEventListener('dragleave', () => b.classList.remove('drop'));
      b.addEventListener('drop', async (e) => {
        b.classList.remove('drop');
        const boardSrc = e.dataTransfer.getData('application/x-clipshelf-board');
        if (boardSrc) {
          e.preventDefault();
          reorderPinboards(boardSrc, id);
          return;
        }
        const ids = (e.dataTransfer.getData('application/x-clipshelf-item') || '').split(',').filter(Boolean);
        if (!ids.length || id === HISTORY) return;
        e.preventDefault();
        const n = await api.pinTo(ids, id);
        if (n) toast(`${label} に固定しました`);
      });
      if (id !== HISTORY) {
        b.draggable = true;
        b.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-clipshelf-board', id);
          b.classList.add('dragging');
        });
        b.addEventListener('dragend', () => b.classList.remove('dragging'));
      }
      return b;
    };
    nodes.push(tab(HISTORY, 'クリップボード履歴'));
    for (const p of state.pinboards) nodes.push(tab(p.id, p.name, p.color));
    const add = el('button', 'board add');
    add.type = 'button';
    add.title = 'ピンボードを作成（⇧⌘N）';
    add.append(icon('plus'));
    add.addEventListener('click', () => createPinboard());
    nodes.push(add);
    box.replaceChildren(...nodes);
  }

  function renderTokens() {
    const box = $('tokens');
    const tokens = [];
    for (const t of state.filters.types) tokens.push((TYPE_FILTERS.find((x) => x[0] === t) || [])[1]);
    for (const a of state.filters.apps) tokens.push(a || '不明なアプリ');
    if (state.filters.date) tokens.push((DATE_FILTERS.find((x) => x[0] === state.filters.date) || [])[1]);
    box.replaceChildren(...tokens.filter(Boolean).map((t) => el('span', 'token', t)));
    const active = document.activeElement === searchEl || !!state.query || tokens.length > 0;
    searchBox.classList.toggle('active', active);
    $('clearSearch').hidden = !(state.query || tokens.length);
  }

  function renderPaused() {
    const p = $('paused');
    p.hidden = !state.paused;
    p.textContent = '一時停止中';
    p.title = 'クリックで記録を再開（⌘T）';
    p.onclick = () => api.resume();
  }

  // Which pinboard an item lives in: its own board for pins, or the board
  // holding a pinned copy of the same content for history items.
  let pinIndexCache = { pins: null, boards: null, map: new Map() };
  function pinIndex() {
    if (pinIndexCache.pins === state.pins && pinIndexCache.boards === state.pinboards && pinIndexCache.len === state.pins.length) return pinIndexCache.map;
    const map = new Map();
    const def = state.info && state.info.defaultPinboardId;
    const order = new Map(state.pinboards.map((b, i) => [b.id, i]));
    const pins = state.pins.slice().sort((a, b) => (order.get(a.pinboardId || def) ?? 99) - (order.get(b.pinboardId || def) ?? 99));
    for (const p of pins) {
      for (const h of p.matchHashes || []) if (!map.has(h)) map.set(h, p.pinboardId || def);
    }
    pinIndexCache = { pins: state.pins, boards: state.pinboards, len: state.pins.length, map };
    return map;
  }

  function boardOf(item) {
    const def = state.info && state.info.defaultPinboardId;
    const id = item.board === 'pin' ? item.pinboardId || def : item.hash ? pinIndex().get(item.hash) : null;
    return (id && state.pinboards.find((b) => b.id === id)) || null;
  }

  function boardColor(board) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--c-${board.color}`).trim() || '#2f7cf6';
  }

  function headerColor(item) {
    const board = boardOf(item);
    if (board) return boardColor(board);
    if (item.appColor) return item.appColor;
    return { text: '#5b6472', url: '#2f7cf6', image: '#30a46c', file: '#8e6ad8' }[item.type] || '#6b7280';
  }

  function isLight(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
    if (!m) return false;
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 186;
  }

  function card(item, index) {
    const c = el('div', 'card');
    c.dataset.id = item.id;
    c.draggable = true;

    // header
    const header = el('header');
    const color = headerColor(item);
    header.style.setProperty('--hc', color);
    if (isLight(color)) header.classList.add('light');
    const titles = el('div', 'titles');
    const title = el('div', 'title');
    if (state.editing && state.editing.kind === 'rename' && state.editing.id === item.id) {
      const input = el('input');
      input.value = item.label || '';
      input.placeholder = typeLabel(item);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (composing(e)) return;
        if (e.key === 'Enter') finishRename(item.id, input.value);
        if (e.key === 'Escape') finishRename(item.id, null);
      });
      input.addEventListener('blur', () => finishRename(item.id, input.value));
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      title.append(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      title.textContent = item.label || typeLabel(item);
      title.addEventListener('click', (e) => {
        if (state.selected.length === 1 && state.selected[0] === item.id && !e.metaKey && !e.shiftKey && !e.ctrlKey) {
          e.stopPropagation();
          startRename(item.id);
        }
      });
    }
    const sub = el('div', 'sub', timeAgo(item.usedAt || item.createdAt));
    const inBoard = boardOf(item);
    if (inBoard && state.boardId === HISTORY) {
      const chip = el('button', 'board-chip', inBoard.name);
      chip.type = 'button';
      chip.title = `「${inBoard.name}」に保存済み（クリックで開く）`;
      chip.addEventListener('mousedown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openInBoard(item, inBoard.id);
      });
      sub.append(chip);
    }
    titles.append(title, sub);
    const app = el('div', 'app');
    if (item.appIcon) {
      const img = el('img');
      img.src = item.appIcon;
      img.alt = '';
      app.title = item.sourceApp || '';
      app.append(img);
    } else {
      app.append(icon(item.type === 'file' && item.files && item.files[0] && item.files[0].isDir ? 'folder' : item.type));
      if (item.sourceApp) app.title = item.sourceApp;
    }
    header.append(titles, app);

    // body
    const body = el('div', 'body');
    const footer = el('footer');
    const left = el('span');
    const right = el('span', 'ocr');
    if (item.type === 'image') {
      const box = el('div', 'image');
      fillThumb(box, item);
      body.append(box);
      if (item.imageSize) left.textContent = `${item.imageSize.width} × ${item.imageSize.height}`;
      if (item.ocrText) right.textContent = item.ocrText.replace(/\s+/g, ' ');
      else if (item.ocrPending) right.textContent = '文字を読み取り中…';
    } else if (item.type === 'file') {
      const box = el('div', 'file');
      const st = state.fileStatus[item.id];
      if (st && st.every((x) => x === 'missing')) box.classList.add('missing');
      fillThumb(box, item);
      const files = item.files || [];
      box.append(el('div', 'name', files.length > 1 ? `${files[0].name} ほか ${files.length - 1} 件` : files[0] ? files[0].name : ''));
      body.append(box);
      const total = files.reduce((n, f) => n + (f.size || 0), 0);
      left.textContent = files.length > 1 ? `${files.length} ファイル` : files[0] && files[0].isDir ? 'フォルダ' : formatBytes(total);
      if (st && st.some((x) => x === 'missing')) right.textContent = '元のファイルが見つかりません';
    } else if (item.type === 'url') {
      const box = el('div', 'link');
      const thumb = el('div', 'thumb');
      if (item.linkImage) fillThumb(thumb, item);
      else thumb.append(icon('url'));
      const meta = el('div', 'meta');
      meta.append(el('div', 'ltitle', item.linkTitle || hostOf(item.text)), el('div', 'lurl', item.text));
      box.append(thumb, meta);
      body.append(box);
      left.textContent = hostOf(item.text);
    } else {
      const hex = colorOf(item.text);
      if (hex) {
        const sw = el('div', 'swatch');
        sw.style.background = hex;
        sw.append(el('span', null, item.text.trim()));
        body.append(sw);
        left.textContent = 'カラー';
      } else {
        const t = el('div', 'text', (item.preview || item.text || '').slice(0, 1200));
        if (/^\s*[{[<]|;\s*$|^\s*(const|let|function|import|def|class|SELECT)\b/m.test(item.text || '')) t.classList.add('mono');
        body.append(t);
        const chars = Array.from(item.text || '').length;
        left.textContent = `${chars.toLocaleString()}文字`;
        if (item.hasRich) right.textContent = '書式あり';
      }
    }
    footer.append(left, right);
    c.append(header, body, footer);
    if (index < 9) c.append(el('span', 'num', `${CS.MOD_LABEL[state.settings.quickPasteModifier] || '⌘'}${index + 1}`));

    if (state.editing && state.editing.kind === 'edit' && state.editing.id === item.id) body.append(editor(item));

    // mouse
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      clickSelect(item.id, e);
    });
    c.addEventListener('dblclick', (e) => {
      if (state.editing) return;
      pasteSelected({ plain: modHeld(e, state.settings.plainTextModifier) });
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.selected.includes(item.id)) {
        state.selected = [item.id];
        updateSelection();
      }
      itemMenu();
    });
    c.addEventListener('dragstart', (e) => dragStart(e, item, c));
    c.addEventListener('dragend', () => {
      c.classList.remove('dragging');
      state.dragIds = null;
      api.panelDragOut(false);
    });
    if (state.boardId !== HISTORY) {
      c.addEventListener('dragover', (e) => {
        if (!state.dragIds) return;
        e.preventDefault();
        c.classList.add('drop-before');
      });
      c.addEventListener('dragleave', () => c.classList.remove('drop-before'));
      c.addEventListener('drop', (e) => {
        c.classList.remove('drop-before');
        if (!state.dragIds) return;
        e.preventDefault();
        reorderPins(state.dragIds, item.id);
      });
    }
    return c;
  }

  function fillThumb(box, item) {
    const cached = state.thumbs.get(`${item.id}:${item.updatedAt}`);
    const put = (src) => {
      if (!src) {
        if (item.type === 'file') box.prepend(icon(item.files && item.files[0] && item.files[0].isDir ? 'folder' : 'file'));
        return;
      }
      const img = el('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      box.prepend(img);
    };
    if (cached !== undefined) return put(cached);
    api.thumbnail(item.id, 480).then((src) => {
      state.thumbs.set(`${item.id}:${item.updatedAt}`, src);
      if (box.isConnected) put(src);
    });
  }

  function editor(item) {
    const box = el('div', 'editor');
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    box.addEventListener('dblclick', (e) => e.stopPropagation());
    const bar = el('div', 'bar');
    const save = button('保存', null, 'btn primary');
    const cancel = button('キャンセル', () => finishEdit(null));
    if (item.type === 'image') {
      const rotate = (turns) => async () => {
        await api.updateItem(item.id, { rotate: turns });
        finishEdit(null);
      };
      box.append(el('div', 'text', '画像を回転'));
      bar.append(button('↺ 左に回転', rotate(3)), button('↻ 右に回転', rotate(1)), cancel);
      box.append(bar);
      return box;
    }
    const area = el('textarea');
    area.value = item.text || '';
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (composing(e)) return;
      if (e.key === 'Escape') finishEdit(null);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finishEdit(area.value);
    });
    save.onclick = () => finishEdit(area.value);
    bar.append(el('span', 'hint', `${isMac ? '⌘' : 'Ctrl+'}Enter で保存`), cancel, save);
    box.append(area, bar);
    setTimeout(() => area.focus(), 0);
    return box;
  }

  function newItemCard() {
    const c = el('div', 'card selected');
    const header = el('header');
    header.style.setProperty('--hc', '#5b6472');
    const titles = el('div', 'titles');
    const title = el('div', 'title');
    const label = el('input');
    label.placeholder = '新しいテキストアイテム';
    label.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (composing(e)) return;
      if (e.key === 'Escape') cancelNew();
      if (e.key === 'Enter') area.focus();
    });
    title.append(label);
    titles.append(title, el('div', 'sub', 'たった今'));
    header.append(titles);
    const body = el('div', 'body');
    const box = el('div', 'editor');
    const area = el('textarea');
    area.placeholder = 'テキストを入力';
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (composing(e)) return;
      if (e.key === 'Escape') cancelNew();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) createNew();
    });
    const bar = el('div', 'bar');
    bar.append(el('span', 'hint', `${isMac ? '⌘' : 'Ctrl+'}Enter で作成`), button('キャンセル', () => cancelNew()), button('作成', () => createNew(), 'btn primary'));
    box.append(area, bar);
    body.append(box);
    c.append(header, body);
    async function createNew() {
      if (!area.value.trim()) return;
      const created = await api.createText({
        text: area.value,
        label: label.value,
        board: state.boardId === HISTORY ? 'history' : 'pin',
        pinboardId: state.boardId === HISTORY ? null : state.boardId
      });
      state.editing = null;
      setModal(false);
      if (created) {
        upsert(created);
        state.selected = [created.id];
      }
      scheduleRender();
      cardsEl.focus();
    }
    function cancelNew() {
      state.editing = null;
      setModal(false);
      scheduleRender();
      cardsEl.focus();
    }
    setTimeout(() => area.focus(), 0);
    return c;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    if (onClick) b.onclick = onClick;
    return b;
  }

  function updateSelection() {
    const sel = new Set(state.selected);
    for (const c of cardsEl.querySelectorAll('.card[data-id]')) c.classList.toggle('selected', sel.has(c.dataset.id));
    const focusId = state.anchor && sel.has(state.anchor) ? state.anchor : state.selected[state.selected.length - 1];
    const node = focusId && cardsEl.querySelector(`.card[data-id="${focusId}"]`);
    if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function requestFileStatus(items) {
    const ids = items.filter((i) => i.type === 'file').map((i) => i.id);
    if (!ids.length) return;
    const st = await api.fileStatus(ids);
    let changed = false;
    for (const [id, v] of Object.entries(st)) {
      if (JSON.stringify(state.fileStatus[id]) !== JSON.stringify(v)) {
        state.fileStatus[id] = v;
        changed = true;
      }
    }
    if (changed) scheduleRender();
  }

  // ------------------------------------------------------------------ selection
  function clickSelect(id, e) {
    const items = visibleItems();
    const ids = items.map((i) => i.id);
    if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      state.selected = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (isMac ? e.metaKey : e.ctrlKey) {
      state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : state.selected.concat(id);
      state.anchor = id;
    } else if (!state.selected.includes(id) || state.selected.length === 1) {
      state.selected = [id];
      state.anchor = id;
    }
    if (document.activeElement === searchEl) cardsEl.focus();
    updateSelection();
  }

  function moveSelection(delta, { extend = false, to = null } = {}) {
    const ids = visibleItems().map((i) => i.id);
    if (!ids.length) return;
    const current = state.anchor && state.selected.includes(state.anchor) ? state.anchor : state.selected[state.selected.length - 1];
    let idx = current ? ids.indexOf(current) : -1;
    if (to === 'first') idx = 0;
    else if (to === 'last') idx = ids.length - 1;
    else idx = Math.max(0, Math.min(ids.length - 1, idx + delta));
    if (idx >= state.limit - 5) {
      state.limit = idx + PAGE;
      render();
    }
    const next = ids[idx];
    if (extend) {
      const start = state.selected.length ? ids.indexOf(state.selected[0]) : idx;
      state.selected = ids.slice(Math.min(start, idx), Math.max(start, idx) + 1);
      if (start > idx) state.selected.reverse();
    } else {
      state.selected = [next];
    }
    state.anchor = next;
    updateSelection();
  }

  function selectedInOrder() {
    const order = visibleItems().map((i) => i.id);
    return state.selected.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  // ------------------------------------------------------------------ actions
  async function pasteSelected({ plain = false } = {}) {
    const ids = selectedInOrder();
    if (!ids.length) return;
    const r = await api.pasteItems(ids, { plain });
    if (r && !r.ok && r.reason === 'files-unavailable') toast('元のファイルが見つかりません');
  }

  async function copySelected({ plain = false } = {}) {
    const ids = selectedInOrder();
    if (!ids.length) return;
    await api.copyItems(ids, { plain });
  }

  async function removeSelected() {
    const ids = selectedInOrder();
    if (!ids.length) return;
    const items = visibleItems().map((i) => i.id);
    const lastIdx = items.indexOf(ids[ids.length - 1]);
    const next = items.slice(lastIdx + 1).find((id) => !ids.includes(id)) || items.slice(0, lastIdx).reverse().find((id) => !ids.includes(id));
    await api.removeItems(ids, 'panel');
    for (const id of ids) removeLocal(id);
    state.selected = next ? [next] : [];
    state.anchor = next || null;
    scheduleRender();
  }

  function startRename(id) {
    state.editing = { id, kind: 'rename' };
    setModal(true);
    render();
  }

  async function finishRename(id, value) {
    if (!state.editing || state.editing.id !== id) return;
    state.editing = null;
    setModal(false);
    if (value !== null) {
      const updated = await api.updateItem(id, { label: value.trim() || null });
      if (updated) upsert(updated);
    }
    scheduleRender({ force: true });
    cardsEl.focus();
  }

  function startEdit(id) {
    const item = listFor(state.boardId).find((i) => i.id === id);
    if (!item || !['text', 'url', 'image'].includes(item.type)) return;
    state.editing = { id, kind: 'edit' };
    setModal(true);
    render();
  }

  async function finishEdit(value) {
    const ed = state.editing;
    state.editing = null;
    setModal(false);
    if (ed && value !== null && value.trim()) {
      const updated = await api.updateItem(ed.id, { text: value });
      if (updated) upsert(updated);
    }
    scheduleRender({ force: true });
    cardsEl.focus();
  }

  function startNewItem() {
    state.editing = { id: null, kind: 'new' };
    setModal(true);
    state.selected = [];
    cardsEl.scrollLeft = 0;
    render();
  }

  async function createPinboard(withIds = null) {
    const board = await api.createPinboard({});
    if (!board) return;
    await loadPinboards();
    if (withIds && withIds.length) await api.pinTo(withIds, board.id);
    startPinboardRename(board.id);
  }

  function startPinboardRename(id) {
    if (state.editing && state.editing.kind === 'pinboard' && state.editing.id === id) return;
    state.editing = { id, kind: 'pinboard' };
    setModal(true);
    renderBoards();
  }

  async function finishPinboardRename(id, value) {
    if (!state.editing || state.editing.kind !== 'pinboard' || state.editing.id !== id) return;
    state.editing = null;
    setModal(false);
    if (value !== null && value.trim()) await api.updatePinboard(id, { name: value.trim() });
    await loadPinboards();
    cardsEl.focus();
  }

  async function reorderPinboards(srcId, beforeId) {
    const ids = state.pinboards.map((b) => b.id).filter((x) => x !== srcId);
    const at = beforeId === HISTORY ? 0 : ids.indexOf(beforeId);
    ids.splice(at < 0 ? ids.length : at, 0, srcId);
    await api.reorderPinboards(ids);
    await loadPinboards();
  }

  async function reorderPins(dragIds, beforeId) {
    const list = listFor(state.boardId).map((i) => i.id).filter((id) => !dragIds.includes(id));
    const at = list.indexOf(beforeId);
    list.splice(at < 0 ? list.length : at, 0, ...dragIds);
    const all = state.pins.filter((i) => !list.includes(i.id)).map((i) => i.id);
    await api.reorderItems(list.concat(all));
  }

  // Jump to the pinboard that holds this content and select the pinned copy.
  function openInBoard(item, boardId) {
    switchBoard(boardId);
    const pin = listFor(boardId).find((p) => p.id === item.id || (item.hash && (p.matchHashes || []).includes(item.hash)));
    if (pin) {
      state.selected = [pin.id];
      state.anchor = pin.id;
    }
    scheduleRender();
  }

  function switchBoard(id) {
    if (state.boardId === id) return;
    state.boardId = id;
    state.selected = [];
    state.anchor = null;
    state.limit = PAGE;
    cardsEl.scrollLeft = 0;
    scheduleRender();
  }

  function cycleBoard(delta) {
    const ids = [HISTORY, ...state.pinboards.map((b) => b.id)];
    const i = ids.indexOf(state.boardId);
    switchBoard(ids[(i + delta + ids.length) % ids.length]);
  }

  async function runAction(r, ids) {
    if (!r) return;
    const [arg] = r.args || [];
    const id = ids[0];
    switch (r.action) {
      case 'paste': return pasteSelected();
      case 'pastePlain': return pasteSelected({ plain: true });
      case 'copy': return copySelected();
      case 'copyPlain': return copySelected({ plain: true });
      case 'preview': return api.previewItem(id, 'panel');
      case 'open': return api.openItem(id).then(() => api.hidePanel({ restoreFocus: false }));
      case 'reveal': return api.revealItem(id).then(() => api.hidePanel({ restoreFocus: false }));
      case 'rename': return startRename(id);
      case 'edit': return startEdit(id);
      case 'duplicate': {
        const d = await api.duplicateItem(id);
        if (d) {
          upsert(d);
          state.selected = [d.id];
          scheduleRender();
        }
        return null;
      }
      case 'pinTo': {
        const n = await api.pinTo(ids, arg);
        const b = state.pinboards.find((x) => x.id === arg);
        if (n && b) toast(`${b.name} に固定しました`);
        return null;
      }
      case 'newPinboardWith': return createPinboard(ids);
      case 'unpin': return api.unpin(ids).then(() => ids.forEach(removeLocal)).then(scheduleRender);
      case 'sendToShelf': return api.sendToShelf(ids).then((n) => n && toast('シェルフに置きました'));
      case 'ocr': return api.runOcr(id);
      case 'remove': return removeSelected();
      case 'newText': return startNewItem();
      case 'newPinboard': return createPinboard();
      case 'stack': return api.toggleStack();
      case 'pause': return api.pause(arg);
      case 'resume': return api.resume();
      case 'eraseHistory': return eraseHistory();
      case 'resetHeight': return api.resetPanelHeight();
      case 'settings': return api.openSettings();
      case 'quit': return api.quit();
      default: return null;
    }
  }

  async function itemMenu() {
    const ids = selectedInOrder();
    if (!ids.length) return;
    runAction(await api.itemMenu(ids, 'panel'), ids);
  }

  async function pinboardMenu(id) {
    const r = await api.pinboardMenu(id);
    if (!r) return;
    if (r.action === 'rename') startPinboardRename(id);
    else if (r.action === 'color') {
      await api.updatePinboard(id, { color: r.args[0] });
      await loadPinboards();
      scheduleRender();
    } else if (r.action === 'delete') {
      const b = state.pinboards.find((x) => x.id === id);
      const ok = await api.confirm({ message: `本当に「${b ? b.name : ''}」を削除してもよろしいですか？`, detail: 'このピンボードとそのすべてのコンテンツが削除されます。この操作は元に戻すことはできません。', ok: '削除' });
      if (ok) {
        await api.deletePinboard(id);
        if (state.boardId === id) state.boardId = HISTORY;
        await loadAll();
      }
    } else if (r.action === 'eraseHistory') eraseHistory();
    else if (r.action === 'newPinboard') createPinboard();
  }

  async function eraseHistory() {
    const ok = await api.confirm({ message: 'クリップボードの履歴を消去してもよろしいですか？', detail: '固定されたアイテムとピンボードは削除されません。この操作は元に戻せません。', ok: '消去' });
    if (!ok) return;
    await api.eraseHistory();
    state.history = [];
    scheduleRender();
  }

  // ------------------------------------------------------------------ drag
  function dragStart(e, item, node) {
    if (!state.selected.includes(item.id)) {
      state.selected = [item.id];
      state.anchor = item.id;
      updateSelection();
    }
    const ids = selectedInOrder();
    const items = ids.map((id) => listFor(state.boardId).find((i) => i.id === id)).filter(Boolean);
    state.dragIds = ids;
    node.classList.add('dragging');
    const textual = items.every((i) => i.type === 'text' || i.type === 'url');
    e.dataTransfer.setData('application/x-clipshelf-item', ids.join(','));
    if (textual) {
      e.dataTransfer.setData('text/plain', items.map((i) => i.text || '').join('\n'));
      if (items.length === 1 && items[0].type === 'url') e.dataTransfer.setData('text/uri-list', items[0].text);
      e.dataTransfer.effectAllowed = 'copy';
      api.panelDragOut(true);
      return;
    }
    // Files and images: the OS drag is run by the main process, which can
    // hand real files to Finder / Explorer and other apps.
    e.preventDefault();
    state.dragIds = null;
    node.classList.remove('dragging');
    api.startDrag(ids, 'panel');
  }

  // ------------------------------------------------------------------ search / filters
  function focusSearch() {
    searchBox.classList.add('active');
    searchEl.focus();
  }

  function clearSearch() {
    searchEl.value = '';
    state.query = '';
    state.filters = { types: new Set(), apps: new Set(), date: null };
    $('filters').hidden = true;
    scheduleRender();
  }

  function toggleFilters(force) {
    const box = $('filters');
    box.hidden = force === undefined ? !box.hidden : !force;
    if (!box.hidden) renderFilters();
  }

  function renderFilters() {
    const box = $('filters');
    const group = (label, entries, isOn, onToggle) => {
      const g = el('div', 'group');
      g.append(el('span', null, label));
      for (const [value, text] of entries) {
        const c = el('button', 'chip', text);
        c.type = 'button';
        c.setAttribute('aria-pressed', String(isOn(value)));
        c.onclick = () => {
          onToggle(value);
          renderFilters();
          scheduleRender();
        };
        g.append(c);
      }
      return g;
    };
    const toggleSet = (set) => (v) => (set.has(v) ? set.delete(v) : set.add(v));
    const apps = [...new Set(listFor(state.boardId).map((i) => i.sourceApp).filter(Boolean))].slice(0, 12);
    box.replaceChildren(
      group('種類', TYPE_FILTERS, (v) => state.filters.types.has(v), toggleSet(state.filters.types)),
      group('期間', DATE_FILTERS, (v) => state.filters.date === v, (v) => {
        state.filters.date = state.filters.date === v ? null : v;
      }),
      ...(apps.length ? [group('アプリ', apps.map((a) => [a, a]), (v) => state.filters.apps.has(v), toggleSet(state.filters.apps))] : [])
    );
  }

  $('searchIcon').append(icon('search'));
  $('searchIcon').addEventListener('click', () => focusSearch());
  $('clearSearch').append(icon('close'));
  $('clearSearch').addEventListener('click', () => {
    clearSearch();
    focusSearch();
  });
  $('filterBtn').append(icon('filter'));
  $('filterBtn').addEventListener('click', () => toggleFilters());
  $('moreBtn').append(icon('more'));
  $('moreBtn').addEventListener('click', async () => {
    runAction(await api.panelMenu(), selectedInOrder());
  });
  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    state.selected = [];
    state.limit = PAGE;
    cardsEl.scrollLeft = 0;
    scheduleRender();
  });
  searchEl.addEventListener('focus', () => renderTokens());
  searchEl.addEventListener('blur', () => setTimeout(renderTokens, 0));

  // ------------------------------------------------------------------ resize
  (function setupResize() {
    const handle = $('resize');
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      start = { y: e.screenY, h: window.outerHeight };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      api.resizePanel(start.h + (start.y - e.screenY));
    });
    const end = () => {
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('dblclick', () => api.resetPanelHeight());
  })();
  window.addEventListener('resize', () => panelEl.classList.toggle('compact', window.innerHeight < COMPACT_BELOW));

  // horizontal scrolling with a normal mouse wheel
  cardsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      cardsEl.scrollLeft += e.deltaY;
      e.preventDefault();
    }
    if (cardsEl.scrollLeft + cardsEl.clientWidth > cardsEl.scrollWidth - 600) {
      const total = visibleItems().length;
      if (state.limit < total) {
        state.limit += PAGE;
        scheduleRender();
      }
    }
  }, { passive: false });

  // ------------------------------------------------------------------ keyboard
  function inTextField(target) {
    return target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target !== searchEl));
  }

  document.addEventListener('keydown', (e) => {
    if (composing(e)) return;
    const s = state.settings;
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
      if (modHeld(e, s.quickPasteModifier)) document.body.classList.add('show-nums');
    }
    if (inTextField(e.target) || (state.editing && state.editing.kind !== 'new' && e.key !== 'Escape')) return;
    const inSearch = document.activeElement === searchEl;
    const key = e.key;

    // quick paste: ⌘1…⌘9 (+ plain-text modifier)
    const digit = /^(Digit|Numpad)([1-9])$/.exec(e.code || '');
    if (digit && modHeld(e, s.quickPasteModifier)) {
      e.preventDefault();
      const item = visibleItems()[Number(digit[2]) - 1];
      if (item) {
        state.selected = [item.id];
        const plain = s.plainTextModifier !== s.quickPasteModifier && modHeld(e, s.plainTextModifier);
        pasteSelected({ plain });
      }
      return;
    }
    if (cmd && key === ',') return prevent(e, () => api.openSettings());
    if (cmd && key.toLowerCase() === 'q') return prevent(e, () => api.quit());
    if (cmd && key.toLowerCase() === 'f') {
      return prevent(e, () => {
        if (inSearch) toggleFilters(true);
        else focusSearch();
      });
    }
    if (cmd && e.shiftKey && key.toLowerCase() === 'n') return prevent(e, () => createPinboard());
    if (cmd && key.toLowerCase() === 'n') return prevent(e, () => startNewItem());
    if (cmd && key.toLowerCase() === 't') return prevent(e, () => (state.paused ? api.resume() : api.pause(null)));
    if (cmd && key.toLowerCase() === 'z' && !inSearch) return prevent(e, async () => {
      const n = await api.undoRemove();
      if (n) {
        await loadAll();
        toast('元に戻しました');
      }
    });
    const caretKeys = inSearch && searchEl.value && /^Arrow/.test(key);
    if (!caretKeys && matchesAccel(e, s.shortcuts.nextPinboard)) return prevent(e, () => cycleBoard(1));
    if (!caretKeys && matchesAccel(e, s.shortcuts.prevPinboard)) return prevent(e, () => cycleBoard(-1));

    if (key === 'Escape') {
      return prevent(e, () => {
        if (state.editing) {
          state.editing = null;
          setModal(false);
          scheduleRender({ force: true });
        } else if (!$('filters').hidden) toggleFilters(false);
        else if (state.query || state.filters.types.size || state.filters.apps.size || state.filters.date) clearSearch();
        else api.hidePanel();
      });
    }
    if (key === 'Tab') {
      return prevent(e, () => {
        if (inSearch) cardsEl.focus();
        else focusSearch();
      });
    }
    if (inSearch) {
      if (key === 'Enter') return prevent(e, () => cardsEl.focus());
      if (key === 'ArrowDown') return prevent(e, () => cardsEl.focus());
      return; // typing goes to the search field
    }

    switch (key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        const d = key === 'ArrowRight' ? 1 : -1;
        return prevent(e, () => moveSelection(d, { extend: e.shiftKey }));
      }
      case 'ArrowUp':
        if (cmd) return prevent(e, () => moveSelection(0, { to: 'first' }));
        return prevent(e, () => focusSearch());
      case 'ArrowDown':
        if (cmd) return prevent(e, () => moveSelection(0, { to: 'last' }));
        return undefined;
      case 'Home':
        return prevent(e, () => moveSelection(0, { to: 'first' }));
      case 'End':
        return prevent(e, () => moveSelection(0, { to: 'last' }));
      case 'Enter':
        return prevent(e, () => pasteSelected({ plain: modHeld(e, s.plainTextModifier) }));
      case ' ':
        return prevent(e, () => state.selected[0] && api.previewItem(state.selected[0], 'panel'));
      case 'Backspace':
      case 'Delete':
        return prevent(e, () => removeSelected());
      default:
        break;
    }
    if (cmd) {
      switch (key.toLowerCase()) {
        case 'c': return prevent(e, () => copySelected({ plain: modHeld(e, s.plainTextModifier) && s.plainTextModifier !== 'Command' }));
        case 'a': return prevent(e, () => {
          state.selected = visibleItems().slice(0, 5000).map((i) => i.id);
          updateSelection();
        });
        case 'o': return prevent(e, () => runAction({ action: 'open' }, selectedInOrder()));
        case 'r': return prevent(e, () => state.selected[0] && startRename(state.selected[0]));
        case 'e': return prevent(e, () => state.selected[0] && startEdit(state.selected[0]));
        case 'g': return prevent(e, () => updateSelection());
        case 'p': return prevent(e, () => itemMenu());
        default: return undefined;
      }
    }
    // printable key → start searching
    if (key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) focusSearch();
    return undefined;
  });

  document.addEventListener('keyup', (e) => {
    if (!modHeld(e, state.settings.quickPasteModifier)) document.body.classList.remove('show-nums');
  });
  window.addEventListener('blur', () => document.body.classList.remove('show-nums'));

  function prevent(e, fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }

  function matchesAccel(e, acc) {
    if (!acc) return false;
    const r = ClipShelfAccelerator.fromKeyboardEvent(e, api.platform);
    return !!(r && r.accelerator === acc);
  }

  // ------------------------------------------------------------------ show / hide
  api.onPanelShow(async (opts = {}) => {
    state.open = true;
    state.targetApp = opts.targetApp || null;
    state.editing = null;
    modalOpen = false;
    state.limit = PAGE;
    if (opts.pinboardId) state.boardId = opts.pinboardId;
    searchEl.value = '';
    state.query = '';
    state.filters = { types: new Set(), apps: new Set(), date: null };
    // Paste starts at the newest item each time.
    const list = visibleItems();
    state.selected = list.length ? [list[0].id] : [];
    state.anchor = state.selected[0] || null;
    cardsEl.scrollLeft = 0;
    render();
    panelEl.classList.remove('closing');
    requestAnimationFrame(() => panelEl.classList.add('open'));
    if (opts.focusSearch) focusSearch();
    else cardsEl.focus();
  });

  api.onPanelHide(() => {
    state.open = false;
    state.editing = null;
    modalOpen = false;
    panelEl.classList.add('closing');
    panelEl.classList.remove('open');
    document.body.classList.remove('show-nums');
    $('filters').hidden = true;
    if (!state.query) searchBox.classList.remove('active');
  });

  // ------------------------------------------------------------------ live updates
  api.onItemsChanged((item) => {
    upsert(item);
    scheduleRender();
  });
  api.onItemsRemoved((id) => {
    removeLocal(id);
    scheduleRender();
  });
  api.onItemsReset(() => loadAll());
  api.onIconsChanged(() => loadAll());
  api.onSettingsChanged((s) => {
    state.settings = s;
    scheduleRender();
  });
  api.onPauseChanged((p) => {
    state.paused = p.paused;
    renderPaused();
  });

  setInterval(() => {
    if (state.open) scheduleRender(); // refresh "N分前"
  }, 60000);

  (async function init() {
    const [info, settings, pause] = await Promise.all([api.appInfo(), api.getSettings(), api.pauseState()]);
    state.info = info;
    state.settings = settings;
    state.paused = pause.paused;
    await loadAll();
  })();

  window.__panel = { state, visibleItems }; // for the automated smoke test
})();
