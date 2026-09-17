'use strict';
/* global CS */
(function () {
  const { api, isMac, el, icon, typeLabel } = CS;
  const $ = (id) => document.getElementById(id);
  let st = { items: [], order: 'fifo', active: false };
  let dragId = null;

  function render() {
    const list = $('items');
    list.replaceChildren(...st.items.map((item, i) => row(item, i)));
    $('empty').hidden = st.items.length > 0;
    $('count').textContent = st.items.length ? `${st.items.length} 件` : '';
    const paste = isMac ? '⌘V' : 'Ctrl+V';
    $('hint').textContent = `コピーするたびに下に追加され、${paste} を押すたびに上から順に貼り付けます`;
    const o = $('order');
    o.replaceChildren(icon(st.order === 'fifo' ? 'arrowDown' : 'arrowUp'));
    o.title = st.order === 'fifo' ? '新しいアイテムを下に追加（クリックで上に追加）' : '新しいアイテムを上に追加（クリックで下に追加）';
  }

  function row(item, i) {
    const r = el('li', 'row');
    if (i === 0) r.classList.add('next');
    r.draggable = true;
    r.append(el('span', 'n', String(i + 1)));
    if (item.type === 'image' || item.type === 'file') {
      const img = el('img');
      img.alt = '';
      api.thumbnail(item.id, 64).then((src) => {
        if (src) img.src = src;
      });
      r.append(img);
    }
    const text = item.type === 'file' ? (item.files || []).map((f) => f.name).join(', ') : item.label || item.preview || item.text || typeLabel(item);
    r.append(el('span', 't', String(text).replace(/\s+/g, ' ')));
    const del = el('button', 'icon-btn');
    del.type = 'button';
    del.title = '削除';
    del.append(icon('close'));
    del.onclick = () => api.removeFromStack([item.id]);
    r.append(del);
    r.addEventListener('dragstart', (e) => {
      dragId = item.id;
      e.dataTransfer.setData('application/x-clipshelf-stack', item.id);
    });
    r.addEventListener('dragover', (e) => {
      e.preventDefault();
      r.classList.add('drop-before');
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-before'));
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      r.classList.remove('drop-before');
      const fromPanel = e.dataTransfer.getData('application/x-clipshelf-item');
      if (fromPanel) {
        api.addToStack(fromPanel.split(','), i);
        return;
      }
      if (!dragId || dragId === item.id) return;
      const ids = st.items.map((x) => x.id).filter((x) => x !== dragId);
      ids.splice(ids.indexOf(item.id), 0, dragId);
      api.reorderStack(ids);
      dragId = null;
    });
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') api.removeFromStack([item.id]);
    });
    r.tabIndex = 0;
    return r;
  }

  // Items dragged from the panel onto the empty area are appended.
  document.body.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types).includes('application/x-clipshelf-item')) e.preventDefault();
  });
  document.body.addEventListener('drop', (e) => {
    const ids = e.dataTransfer.getData('application/x-clipshelf-item');
    if (ids) {
      e.preventDefault();
      api.addToStack(ids.split(','));
    }
  });

  $('close').append(icon('close'));
  $('close').onclick = () => api.closeStack();
  $('order').onclick = () => api.toggleStackOrder();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeStack();
  });

  api.onStackState((s) => {
    st = s;
    render();
  });
  api.stackState().then((s) => {
    st = s;
    render();
  });
})();
