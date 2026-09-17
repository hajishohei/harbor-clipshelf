'use strict';
/* global CS */
// Yoink-style shelf.
(function () {
  const { api, isMac, el, icon, formatBytes, toast, composing } = CS;
  const OWN_TYPE = 'application/x-clipshelf-shelf';
  const PANEL_TYPE = 'application/x-clipshelf-item';

  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const shelfEl = $('shelf');
  const state = {
    items: [],
    selected: [],
    anchor: null,
    thumbs: new Map(),
    status: {},
    renaming: null,
    dragDepth: 0,
    systemDrag: false,
    dragging: null,
    collapsed: false,
    expanded: new Set(), // stacks opened to show their files
    pendingSingle: null,
    menuOpen: false
  };
  const REF_SEP = '#';
  const isChildRef = (id) => typeof id === 'string' && id.includes(REF_SEP);

  // ------------------------------------------------------------ data
  async function load() {
    state.items = await api.listShelf();
    sort();
    render();
    refreshStatus();
  }

  function sort() {
    state.items.sort((a, b) => (b.usedAt || b.createdAt || 0) - (a.usedAt || a.createdAt || 0));
  }

  api.onItemsChanged((item) => {
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      const before = state.items[idx];
      // the stack's files changed: "#n" selections may point at different files now
      if ((before.files || []).length !== (item.files || []).length || before.updatedAt !== item.updatedAt) {
        state.selected = state.selected.filter((x) => !x.startsWith(item.id + REF_SEP));
        if ((item.files || []).length < 2) state.expanded.delete(item.id);
      }
      state.items.splice(idx, 1);
    }
    if (item.board === 'shelf' && !item.deleted) {
      state.items.push(item);
      sort();
    }
    render();
    if (item.type === 'file') refreshStatus();
  });
  api.onItemsRemoved((id) => {
    state.items = state.items.filter((i) => i.id !== id);
    state.selected = state.selected.filter((x) => x !== id && !x.startsWith(id + REF_SEP));
    state.expanded.delete(id);
    render();
  });
  api.onItemsReset(load);
  api.onFileStatus((st) => {
    Object.assign(state.status, st);
    render();
  });
  api.onShelfState((s) => {
    document.body.classList.toggle('left', s.side === 'left');
    document.body.classList.toggle('right', s.side !== 'left');
    document.body.classList.toggle('collapsed', !!s.collapsed);
    state.collapsed = !!s.collapsed;
    renderTab(s.count);
    state.systemDrag = !!s.dragging;
    updateDropzone();
    if (s.visible) refreshStatus();
  });

  async function refreshStatus() {
    const ids = state.items.filter((i) => i.type === 'file').map((i) => i.id);
    if (!ids.length) return;
    const st = await api.fileStatus(ids);
    if (JSON.stringify(st) !== JSON.stringify(state.status)) {
      state.status = st;
      render();
    }
  }
  setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, 3000);

  // ------------------------------------------------------------ render
  function render({ force = false } = {}) {
    if (state.renaming && !force) {
      state.renderDeferred = true;
      return;
    }
    const scroll = listEl.scrollTop;
    const nodes = [];
    for (const item of state.items) {
      nodes.push(tile(item));
      const files = item.files || [];
      if (item.type === 'file' && files.length > 1 && state.expanded.has(item.id)) {
        const box = el('div', 'children');
        files.forEach((f, i) => box.append(childTile(item, f, i)));
        nodes.push(box);
      }
    }
    listEl.replaceChildren(...nodes);
    listEl.scrollTop = scroll;
    $('count').textContent = state.items.length ? `${state.items.length} 項目` : '';
    document.body.classList.toggle('multi', state.selected.length > 1);
    renderTab(state.items.length);
    updateDropzone();
  }

  function renderTab(count) {
    const tab = $('tab');
    if (!tab.querySelector('.svg')) tab.prepend(icon(document.body.classList.contains('right') ? 'chevronLeft' : 'chevronRight'));
    const svg = tab.querySelector('.svg');
    const want = document.body.classList.contains('right') ? 'chevronLeft' : 'chevronRight';
    if (svg && svg.dataset.icon !== want) {
      const next = icon(want);
      next.dataset.icon = want;
      svg.replaceWith(next);
    }
    const n = Number.isFinite(count) ? count : state.items.length;
    $('tabCount').textContent = n ? String(n) : '';
    tab.title = n ? `シェルフを開く（${n} 項目）` : 'シェルフを開く';
  }

  // Rows in display order (stack children included when opened).
  function rowIds() {
    const ids = [];
    for (const item of state.items) {
      ids.push(item.id);
      const files = item.files || [];
      if (item.type === 'file' && files.length > 1 && state.expanded.has(item.id)) files.forEach((_f, i) => ids.push(`${item.id}${REF_SEP}${i}`));
    }
    return ids;
  }

  function childTile(item, f, index) {
    const ref = `${item.id}${REF_SEP}${index}`;
    const t = el('div', 'tile child');
    t.dataset.id = ref;
    t.draggable = true;
    if (state.selected.includes(ref)) t.classList.add('selected');
    const st = state.status[item.id];
    if (st && st[index] === 'missing') t.classList.add('missing');
    if (st && st[index] === 'trash') t.classList.add('trash');
    const thumb = el('div', 'thumb');
    const key = `${ref}:${item.updatedAt}`;
    const put = (src) => {
      thumb.replaceChildren();
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        thumb.append(img);
      } else {
        thumb.append(icon(f.isDir ? 'folder' : 'file'));
      }
    };
    if (state.thumbs.has(key)) put(state.thumbs.get(key));
    else {
      put(null);
      api.thumbnail(ref, 96).then((src) => {
        state.thumbs.set(key, src);
        if (t.isConnected && src) put(src);
      });
    }
    const name = el('div', 'name', f.name || '');
    t.title = `${f.name}${f.size ? `（${formatBytes(f.size)}）` : ''}${f.path ? `\n${f.path}` : ''}`;
    const controls = el('div', 'controls');
    controls.append(
      ctlButton('close', 'スタックから取り出して削除', () => removeItems([ref])),
      ctlButton('eye', 'クイックルック', () => api.previewItem(ref, 'shelf'))
    );
    t.append(checkButton(ref), thumb, name, controls);
    wireTile(t, ref);
    return t;
  }

  function ctlButton(iconName, title, fn, cls = '') {
    const b = el('button', `icon-btn ${cls}`);
    b.type = 'button';
    b.title = title;
    b.append(icon(iconName));
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  function checkButton(id) {
    const c = el('button', 'check');
    c.type = 'button';
    c.title = '選択';
    c.append(icon('check'));
    c.addEventListener('mousedown', (e) => e.stopPropagation());
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : state.selected.concat(id);
      state.anchor = id;
      paintSelection();
    });
    return c;
  }

  function paintSelection() {
    for (const n of listEl.querySelectorAll('.tile')) n.classList.toggle('selected', state.selected.includes(n.dataset.id));
    document.body.classList.toggle('multi', state.selected.length > 1);
  }

  function wireTile(t, id) {
    t.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const plain = !e.shiftKey && !(isMac ? e.metaKey : e.ctrlKey);
      // Keep a multi-selection for dragging; a plain click without drag selects just this one.
      state.pendingSingle = plain && state.selected.includes(id) && state.selected.length > 1 ? id : null;
      select(id, e);
    });
    t.addEventListener('mouseup', () => {
      if (state.pendingSingle === id) {
        state.selected = [id];
        state.anchor = id;
        paintSelection();
      }
      state.pendingSingle = null;
    });
    t.addEventListener('dblclick', () => api.openItem(id));
    t.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (!state.selected.includes(id)) select(id, {});
      setBusy(true);
      try {
        runMenu(await api.itemMenu(selectedIds(), 'shelf'));
      } finally {
        setBusy(false);
      }
    });
    t.addEventListener('dragstart', (e) => {
      state.pendingSingle = null;
      dragStart(e, id);
    });
    t.addEventListener('dragend', (e) => dragEnd(e));
  }

  function setBusy(busy) {
    state.menuOpen = busy;
    api.setShelfBusy(busy || !!state.renaming);
  }

  $('tab').addEventListener('click', () => api.expandShelf());

  function updateDropzone() {
    const dz = $('dropzone');
    dz.hidden = state.items.length > 0 && !(state.dragDepth > 0 && state.items.length === 0);
    if (!dz.firstChild) dz.innerHTML = CS.ICONS.drop; // constant markup
  }

  function nameOf(item) {
    if (item.type === 'file') {
      const files = item.files || [];
      return files.length > 1 ? `${files.length} ファイル` : files[0] ? files[0].name : '';
    }
    if (item.label) return item.label;
    if (item.type === 'url') return item.linkTitle || CS.hostOf(item.text);
    if (item.type === 'image') return item.preview || '画像';
    return 'スニペット';
  }

  function tile(item) {
    const t = el('div', 'tile');
    t.dataset.id = item.id;
    t.draggable = true;
    if (state.selected.includes(item.id)) t.classList.add('selected');
    if (item.locked) t.classList.add('locked');
    const st = state.status[item.id];
    if (st && st.every((x) => x === 'missing')) t.classList.add('missing');
    if (st && st.some((x) => x === 'trash')) t.classList.add('trash');

    const thumb = el('div', 'thumb');
    const files = item.files || [];
    if (item.type === 'file' && files.length > 1) thumb.classList.add('stack');
    if (item.type === 'text') {
      thumb.append(el('div', 'text-thumb', (item.text || '').slice(0, 300)));
    } else {
      fillThumb(thumb, item);
      if (item.type === 'file' && files.length > 1) {
        const ghost1 = el('img');
        const ghost2 = el('img');
        const src = state.thumbs.get(`${item.id}:${item.updatedAt}`);
        if (src) {
          ghost1.src = src;
          ghost2.src = src;
          thumb.append(ghost1, ghost2);
        }
      }
    }

    const name = el('div', 'name');
    if (state.renaming === item.id) {
      const input = el('input');
      input.value = nameOf(item);
      input.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (composing(e)) return;
        if (e.key === 'Enter') finishRename(item, input.value);
        if (e.key === 'Escape') finishRename(item, null);
      });
      input.addEventListener('blur', () => finishRename(item, input.value));
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      name.append(input);
      setTimeout(() => {
        input.focus();
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      }, 0);
    } else {
      name.textContent = nameOf(item);
      const details = item.type === 'file' ? files.map((f) => `${f.name}${f.size ? `（${formatBytes(f.size)}）` : ''}${f.path ? `\n${f.path}` : ''}`).join('\n') : item.text || '';
      t.title = st && st.some((x) => x === 'missing') ? `元のファイルが見つかりません\n${details}` : details.slice(0, 500);
    }

    const controls = el('div', 'controls');
    controls.append(ctlButton('close', 'リストから削除', () => removeItems([item.id])));
    if (item.type === 'file' && files.length > 1) controls.append(ctlButton('split', 'スタックを分割', () => api.splitStack(item.id)));
    controls.append(ctlButton('eye', 'クイックルック', () => api.previewItem(item.id, 'shelf')));
    controls.append(ctlButton(item.locked ? 'lock' : 'unlock', item.locked ? 'ピン留めを外す（ドラッグ後も残す設定を解除）' : 'ピン留め（ドラッグして取り出しても残す）', () => api.lockItems([item.id], !item.locked), 'lock'));

    t.append(checkButton(item.id), thumb, name, controls);
    if (item.type === 'file' && files.length > 1) {
      const open = state.expanded.has(item.id);
      t.classList.toggle('open', open);
      const badge = el('button', 'count-badge');
      badge.type = 'button';
      badge.title = open ? 'ファイルの一覧を閉じる' : '中のファイルを1つずつ選ぶ';
      badge.append(document.createTextNode(String(files.length)), icon('chevronDown'));
      badge.addEventListener('mousedown', (e) => e.stopPropagation());
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStack(item.id);
      });
      t.append(badge);
    }
    wireTile(t, item.id);
    return t;
  }

  function toggleStack(id) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
      state.selected = state.selected.filter((x) => !x.startsWith(id + REF_SEP));
    } else {
      state.expanded.add(id);
    }
    render();
  }

  function fillThumb(box, item) {
    const key = `${item.id}:${item.updatedAt}`;
    const put = (src) => {
      box.querySelectorAll('img.main,.svg').forEach((n) => n.remove());
      if (!src) {
        box.prepend(icon(item.type === 'url' ? 'url' : item.type === 'file' && item.files && item.files[0] && item.files[0].isDir ? 'folder' : item.type === 'image' ? 'image' : 'file'));
        return;
      }
      const img = el('img', 'main');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      box.prepend(img);
    };
    if (state.thumbs.has(key)) return put(state.thumbs.get(key));
    put(null);
    api.thumbnail(item.id, 160).then((src) => {
      state.thumbs.set(key, src);
      if (box.isConnected && src) render();
    });
  }

  // ------------------------------------------------------------ selection
  function selectedIds() {
    const order = rowIds();
    return state.selected.filter((x) => order.includes(x)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  function select(id, e) {
    const ids = rowIds();
    if (e.shiftKey && state.anchor) {
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      state.selected = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (isMac ? e.metaKey : e.ctrlKey) {
      state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : state.selected.concat(id);
      state.anchor = id;
    } else if (!state.selected.includes(id)) {
      state.selected = [id];
      state.anchor = id;
    }
    paintSelection();
  }

  function move(delta, extend) {
    const ids = rowIds();
    if (!ids.length) return;
    const cur = state.anchor && ids.includes(state.anchor) ? ids.indexOf(state.anchor) : -1;
    const next = Math.max(0, Math.min(ids.length - 1, cur + delta));
    if (extend && state.selected.length) {
      const start = ids.indexOf(state.selected[0]);
      state.selected = ids.slice(Math.min(start, next), Math.max(start, next) + 1);
    } else {
      state.selected = [ids[next]];
    }
    state.anchor = ids[next];
    render();
    const node = listEl.querySelector(`[data-id="${ids[next]}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ actions
  async function removeItems(ids) {
    if (!ids.length) return;
    await api.removeItems(ids, 'shelf');
  }

  function startRename(id) {
    if (isChildRef(id)) return;
    state.renaming = id;
    api.setShelfBusy(true);
    render({ force: true });
  }

  async function finishRename(item, value) {
    if (state.renaming !== item.id) return;
    state.renaming = null;
    api.setShelfBusy(state.menuOpen);
    if (value !== null && value.trim() && value !== nameOf(item)) {
      const r = await api.renameShelfItem(item.id, value);
      if (r && r.error) toast(r.error);
    }
    render({ force: true });
    listEl.focus();
  }

  async function runMenu(r) {
    if (!r) return;
    const ids = selectedIds();
    const id = ids[0];
    const [arg] = r.args || [];
    switch (r.action) {
      case 'preview': return api.previewItem(id, 'shelf');
      case 'remove': return removeItems(ids);
      case 'lock': return api.lockItems(ids, arg);
      case 'open': return api.openItem(id);
      case 'move': return api.transferItem(id, true).then((out) => out && out.length && toast('移動しました'));
      case 'copyTo': return api.transferItem(id, false).then((out) => out && out.length && toast('コピーしました'));
      case 'rename': return startRename(id);
      case 'reveal': return api.revealItem(id);
      case 'copyPaths': return api.copyPaths(ids).then((n) => n && toast('パスをコピーしました'));
      case 'split': return api.splitStack(id);
      case 'merge': return api.mergeStack(ids);
      case 'restore': return api.restoreShelf();
      case 'addClipboard': return api.addClipboardToShelf();
      case 'position': return api.setShelfPosition(arg);
      case 'park': return api.setSettings({ shelfParkSide: arg });
      case 'collapseIdle': return api.setSettings({ shelfCollapseWhenIdle: arg });
      case 'selectAll': return selectAll();
      case 'size': return api.setShelfSize(arg);
      case 'about': return api.about();
      case 'settings': return api.openSettings('shelf');
      case 'quit': return api.quit();
      default: return null;
    }
  }

  $('gear').append(icon('gear'));
  $('gear').addEventListener('click', async () => {
    setBusy(true);
    try {
      runMenu(await api.shelfGearMenu(selectedIds()));
    } finally {
      setBusy(false);
    }
  });

  function selectAll() {
    state.selected = rowIds();
    paintSelection();
  }
  $('wipe').append(icon('broom'));
  $('wipe').addEventListener('click', () => api.wipeShelf());

  // ------------------------------------------------------------ drag out
  function dragStart(e, id) {
    if (!state.selected.includes(id)) select(id, {});
    const ids = selectedIds();
    const items = ids.map((x) => state.items.find((i) => i.id === x.split(REF_SEP)[0])).filter(Boolean);
    const textual = !ids.some(isChildRef) && items.every((i) => i.type === 'text' || i.type === 'url');
    e.dataTransfer.setData(OWN_TYPE, ids.join(','));
    if (textual) {
      state.dragging = ids;
      api.markShelfDrag();
      e.dataTransfer.setData('text/plain', items.map((i) => i.text || '').join('\n'));
      if (items.length === 1 && items[0].type === 'url') e.dataTransfer.setData('text/uri-list', items[0].text);
      e.dataTransfer.effectAllowed = 'copyMove';
      return;
    }
    e.preventDefault();
    api.startDrag(ids, 'shelf');
  }

  function dragEnd(e) {
    const ids = state.dragging;
    state.dragging = null;
    if (!ids) return;
    const inside = e.clientX >= 0 && e.clientY >= 0 && e.clientX <= window.innerWidth && e.clientY <= window.innerHeight;
    if (e.dataTransfer.dropEffect === 'none' || inside) return;
    api.getSettings().then((s) => {
      if (!s.shelfRemoveAfterDragOut) return;
      const removable = ids.filter((x) => !(state.items.find((i) => i.id === x.split(REF_SEP)[0]) || {}).locked);
      removeItems(removable);
    });
  }

  // ------------------------------------------------------------ drop in
  function isOwn(dt) {
    return Array.from(dt.types || []).includes(OWN_TYPE);
  }

  window.addEventListener('dragenter', (e) => {
    if (isOwn(e.dataTransfer)) return;
    e.preventDefault();
    state.dragDepth++;
    shelfEl.classList.add('over');
    updateDropzone();
  });
  window.addEventListener('dragover', (e) => {
    if (isOwn(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) shelfEl.classList.remove('over');
    updateDropzone();
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    state.dragDepth = 0;
    shelfEl.classList.remove('over');
    updateDropzone();
    const dt = e.dataTransfer;
    if (isOwn(dt)) return;
    const fromPanel = dt.getData(PANEL_TYPE);
    if (fromPanel) {
      await api.sendToShelf(fromPanel.split(',').filter(Boolean));
      return;
    }
    const files = Array.from(dt.files || []);
    const paths = [];
    for (const f of files) {
      const p = api.pathForFile(f);
      if (p) paths.push(p);
      else if (f.size > 0) await api.addBytesToShelf({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    if (paths.length) await api.addPathsToShelf(paths);
    if (!files.length) {
      const text = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (text && text.trim()) await api.addTextToShelf(text.trim());
    }
  });

  // ------------------------------------------------------------ keyboard
  let lastActivity = 0;
  document.addEventListener('keydown', async (e) => {
    if (Date.now() - lastActivity > 500) {
      lastActivity = Date.now();
      api.shelfActivity();
    }
    if (composing(e) || state.renaming) return;
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    const ids = selectedIds();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === ' ' && ids.length) {
      e.preventDefault();
      api.previewItem(ids[0], 'shelf');
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && ids.length) {
      e.preventDefault();
      removeItems(ids);
    } else if (e.key === 'Enter' && ids.length === 1) {
      e.preventDefault();
      startRename(ids[0]);
    } else if (cmd && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
    } else if (cmd && e.key.toLowerCase() === 'c' && ids.length) {
      e.preventDefault();
      const whole = [...new Set(ids.map((x) => x.split(REF_SEP)[0]))];
      await api.copyItems(whole, { close: false });
      toast('コピーしました');
    } else if (cmd && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      api.addClipboardToShelf();
    } else if (cmd && e.key.toLowerCase() === 'o' && ids.length) {
      e.preventDefault();
      api.openItem(ids[0]);
    } else if (cmd && e.key === 'z') {
      e.preventDefault();
      api.restoreShelf();
    } else if (e.key === 'Escape') {
      state.selected = [];
      paintSelection();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ids.length === 1 && !isChildRef(ids[0])) {
      const item = state.items.find((i) => i.id === ids[0]);
      if (item && item.type === 'file' && (item.files || []).length > 1 && state.expanded.has(item.id) !== (e.key === 'ArrowRight')) {
        e.preventDefault();
        toggleStack(item.id);
      }
    }
  });

  load();
  window.__shelf = { state, toggleStack, selectAll, rowIds };
})();
