'use strict';
/* global CS */
(function () {
  const { api, el, icon, timeAgo } = CS;
  const $ = (id) => document.getElementById(id);
  let current = null;

  $('close').append(icon('close'));
  $('close').onclick = () => api.closePreview();
  $('open').onclick = () => current && api.openItem(current.item.id).then(() => api.closePreview());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === ' ' && document.activeElement.tagName !== 'INPUT')) {
      e.preventDefault();
      api.closePreview();
    }
  });

  api.onPreview((p) => {
    current = p;
    const item = p.item;
    $('title').textContent = item.label || item.linkTitle || p.meta.type;
    $('meta').textContent = [p.meta.type, p.meta.app, timeAgo(p.meta.at)].filter(Boolean).join(' ・ ');
    $('open').hidden = !['url', 'file', 'image'].includes(item.type);
    const box = $('content');
    const nodes = [];
    if (item.type === 'image' || (item.type === 'file' && p.image)) {
      const wrap = el('div', 'image');
      const img = el('img');
      img.src = p.image;
      img.alt = '';
      wrap.append(img);
      nodes.push(wrap);
    }
    if (item.type === 'url') {
      const wrap = el('div', 'link');
      const a = el('a', null, p.text);
      a.href = '#';
      a.onclick = (e) => {
        e.preventDefault();
        api.openItem(item.id);
      };
      wrap.append(a);
      if (p.image) {
        const img = el('img');
        img.src = p.image;
        wrap.append(img);
      }
      nodes.push(wrap);
    } else if (item.type === 'text') {
      nodes.push(el('pre', 'text', p.text));
    }
    if (item.type === 'file') {
      const wrap = el('div', 'files');
      for (const f of p.files) {
        const row = el('div', 'f');
        row.append(el('strong', null, `${f.name}${f.size ? `（${f.size}）` : ''}`), el('span', 'p', f.path || ''));
        wrap.append(row);
      }
      nodes.push(wrap);
    }
    if (item.ocrText) nodes.push(el('pre', 'text', `画像の文字:\n${item.ocrText}`));
    box.replaceChildren(...nodes);
    box.scrollTop = 0;
  });
})();
