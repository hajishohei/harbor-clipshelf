'use strict';
/* global CS */
// Quick Look-style popup: images, text, video / audio, folders, stacks.
(function () {
  const { api, el, icon, timeAgo, formatBytes, isMac } = CS;
  const $ = (id) => document.getElementById(id);
  let current = null;

  $('close').append(icon('close'));
  $('close').onclick = () => api.closePreview();
  $('open').onclick = () => current && api.openItem(current.item.id).then(() => api.closePreview());
  $('reveal').textContent = isMac ? 'Finder に表示' : 'フォルダを開く';
  $('reveal').onclick = () => current && api.revealItem(current.item.id).then(() => api.closePreview());
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (e.key === 'Escape' || (e.key === ' ' && !typing)) {
      e.preventDefault();
      api.closePreview();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && current && current.files.length > 1) {
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
    } else if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      $('open').click();
    }
  });

  let stackIndex = 0;
  let stackParent = null;

  function step(delta) {
    const files = current.files;
    const next = Math.max(0, Math.min(files.length - 1, stackIndex + delta));
    if (next !== stackIndex && files[next].ref) showRef(files[next].ref, next);
  }

  function showRef(ref, index) {
    stackIndex = index;
    api.previewItem(ref, current.owner, { replace: true });
  }

  function mediaEl(tag, src) {
    const m = el(tag);
    m.controls = true;
    m.autoplay = tag === 'video';
    m.preload = 'metadata';
    m.src = src;
    return m;
  }

  function contentNodes(p) {
    const c = p.content || {};
    const nodes = [];
    const k = c.kind;
    if (k === 'image' && (c.src || p.image)) {
      const wrap = el('div', 'image');
      const img = el('img');
      img.src = c.src || p.image;
      img.alt = '';
      wrap.append(img);
      nodes.push(wrap);
    } else if (k === 'video') {
      const wrap = el('div', 'media');
      wrap.append(mediaEl('video', c.src));
      nodes.push(wrap);
    } else if (k === 'audio') {
      const wrap = el('div', 'media audio');
      if (c.icon) {
        const i = el('img', 'big-icon');
        i.src = c.icon;
        wrap.append(i);
      }
      wrap.append(mediaEl('audio', c.src));
      nodes.push(wrap);
    } else if (k === 'text') {
      nodes.push(el('pre', 'text mono', c.text + (c.truncated ? '\n…（先頭だけ表示しています）' : '')));
    } else if (k === 'folder') {
      const wrap = el('div', 'folder');
      const head = el('div', 'folder-head');
      if (c.icon) {
        const i = el('img', 'big-icon small');
        i.src = c.icon;
        head.append(i);
      }
      head.append(el('span', null, `${c.count || 0} 項目`));
      wrap.append(head);
      const ul = el('ul');
      for (const e of c.entries || []) {
        const li = el('li', e.dir ? 'dir' : '');
        li.append(icon(e.dir ? 'folder' : 'file'), el('span', null, e.name));
        ul.append(li);
      }
      if ((c.count || 0) > (c.entries || []).length) ul.append(el('li', 'more', `ほか ${(c.count || 0) - c.entries.length} 項目`));
      wrap.append(ul);
      nodes.push(wrap);
    } else if (k === 'other' || k === 'missing') {
      const wrap = el('div', 'other');
      if (c.src) {
        const img = el('img', 'ql');
        img.src = c.src;
        wrap.append(img);
      } else if (c.icon) {
        const img = el('img', 'big-icon');
        img.src = c.icon;
        wrap.append(img);
      } else {
        wrap.append(icon('file'));
      }
      const info = el('div', 'info');
      info.append(el('strong', null, c.name || ''));
      const bits = [];
      if (k === 'missing') bits.push('元のファイルが見つかりません');
      if (c.size != null) bits.push(formatBytes(c.size));
      if (c.modifiedAt) bits.push(`更新 ${new Date(c.modifiedAt).toLocaleString('ja-JP')}`);
      if (bits.length) info.append(el('span', null, bits.join(' ・ ')));
      if (c.path) info.append(el('span', 'p', c.path));
      wrap.append(info);
      nodes.push(wrap);
    } else if (p.item.type === 'url') {
      const wrap = el('div', 'link');
      if (p.item.linkTitle) wrap.append(el('strong', null, p.item.linkTitle));
      const a = el('a', null, p.text);
      a.href = '#';
      a.onclick = (e) => {
        e.preventDefault();
        api.openItem(p.item.id);
      };
      wrap.append(a);
      if (p.image) {
        const img = el('img');
        img.src = p.image;
        wrap.append(img);
      }
      nodes.push(wrap);
    } else if (p.item.type === 'text') {
      nodes.push(el('pre', 'text', p.text));
    } else if (p.image) {
      const wrap = el('div', 'image');
      const img = el('img');
      img.src = p.image;
      wrap.append(img);
      nodes.push(wrap);
    }
    if (p.item.ocrText && p.item.type === 'image') nodes.push(el('pre', 'text ocr', `画像の文字:\n${p.item.ocrText}`));
    return nodes;
  }

  function renderStrip(p) {
    const strip = $('strip');
    const files = p.files || [];
    const refs = files.filter((f) => f.ref);
    if (files.length < 2 || !refs.length) {
      if (!p.item.parentId || !stackParent) strip.hidden = true;
      return;
    }
    stackParent = p;
    strip.hidden = false;
    strip.replaceChildren(
      ...files.map((f, i) => {
        const b = el('button', `strip-item${i === stackIndex ? ' on' : ''}`);
        b.type = 'button';
        b.title = f.name;
        const src = p.stackThumbs && p.stackThumbs[i];
        if (src) {
          const img = el('img');
          img.src = src;
          img.alt = '';
          b.append(img);
        } else {
          b.append(icon(f.isDir ? 'folder' : 'file'));
        }
        b.append(el('span', null, f.name));
        b.onclick = () => showRef(f.ref, i);
        return b;
      })
    );
  }

  api.onPreview((p) => {
    // Showing one file of a stack keeps the stack's strip.
    const inStack = p.item.parentId && stackParent && stackParent.item.id === p.item.parentId;
    if (!inStack) stackIndex = 0;
    current = inStack ? { ...p, files: stackParent.files, owner: p.owner } : p;
    const item = p.item;
    $('title').textContent = p.title || item.label || item.linkTitle || (p.content && p.content.name) || p.meta.type;
    $('meta').textContent = [p.meta.type, p.meta.app, timeAgo(p.meta.at)].filter(Boolean).join(' ・ ');
    $('open').hidden = !['url', 'file', 'image'].includes(item.type);
    $('reveal').hidden = item.type !== 'file';
    const box = $('content');
    box.replaceChildren(...contentNodes(p));
    box.scrollTop = 0;
    if (inStack) {
      for (const [i, n] of Array.from($('strip').children).entries()) n.classList.toggle('on', i === stackIndex);
    } else {
      stackParent = null;
      renderStrip(p);
    }
    document.body.dataset.kind = (p.content && p.content.kind) || item.type;
  });
})();
