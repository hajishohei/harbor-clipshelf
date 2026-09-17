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
    dragging: null
  };

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
    if (idx >= 0) state.items.splice(idx, 1);
    if (item.board === 'shelf' && !item.deleted) {
      state.items.push(item);
      sort();
    }
    render();
    if (item.type === 'file') refreshStatus();
  });
  api.onItemsRemoved((id) => {
    state.items = state.items.filter((i) => i.id !== id);
    state.selected = state.selected.filter((x) => x !== id);
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
    listEl.replaceChildren(...state.items.map(tile));
    listEl.scrollTop = scroll;
    $('count').textContent = state.items.length ? `${state.items.length} 項目` : '';
    updateDropzone();
  }

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
    const ctl = (iconName, title, fn, cls = '') => {
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
    };
    controls.append(ctl('close', 'リストから削除', () => removeItems([item.id])));
    if (item.type === 'file' && files.length > 1) controls.append(ctl('split', 'スタックを分割', () => api.splitStack(item.id)));
    controls.append(ctl('eye', 'クイックルック', () => api.previewItem(item.id, 'shelf')));
    controls.append(ctl(item.locked ? 'lock' : 'unlock', item.locked ? 'ピン留めを外す（ドラッグ後も残す設定を解除）' : 'ピン留め（ドラッグして取り出しても残す）', () => api.lockItems([item.id], !item.locked), 'lock'));

    t.append(thumb, name, controls);

    t.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      select(item.id, e);
    });
    t.addEventListener('dblclick', () => api.openItem(item.id));
    t.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (!state.selected.includes(item.id)) select(item.id, {});
      runMenu(await api.itemMenu(selectedIds(), 'shelf'));
    });
    t.addEventListener('dragstart', (e) => dragStart(e, item));
    t.addEventListener('dragend', (e) => dragEnd(e));
    return t;
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
    const order = state.items.map((i) => i.id);
    return state.selected.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  function select(id, e) {
    const ids = state.items.map((i) => i.id);
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
    for (const n of listEl.children) n.classList.toggle('selected', state.selected.includes(n.dataset.id));
  }

  function move(delta, extend) {
    const ids = state.items.map((i) => i.id);
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
    state.renaming = id;
    render({ force: true });
  }

  async function finishRename(item, value) {
    if (state.renaming !== item.id) return;
    state.renaming = null;
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
      case 'size': return api.setShelfSize(arg);
      case 'about': return api.about();
      case 'settings': return api.openSettings('shelf');
      case 'quit': return api.quit();
      default: return null;
    }
  }

  $('gear').append(icon('gear'));
  $('gear').addEventListener('click', async () => runMenu(await api.shelfGearMenu(selectedIds())));
  $('wipe').append(icon('broom'));
  $('wipe').addEventListener('click', () => api.wipeShelf());

  // ------------------------------------------------------------ drag out
  function dragStart(e, item) {
    if (!state.selected.includes(item.id)) select(item.id, {});
    const ids = selectedIds();
    const items = ids.map((id) => state.items.find((i) => i.id === id)).filter(Boolean);
    const textual = items.every((i) => i.type === 'text' || i.type === 'url');
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
      const removable = ids.filter((id) => !(state.items.find((i) => i.id === id) || {}).locked);
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
  document.addEventListener('keydown', async (e) => {
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
      state.selected = state.items.map((i) => i.id);
      render();
    } else if (cmd && e.key.toLowerCase() === 'c' && ids.length) {
      e.preventDefault();
      await api.copyItems(ids, { close: false });
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
      render();
    }
  });

  load();
  window.__shelf = { state };
})();
