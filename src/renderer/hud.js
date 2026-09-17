'use strict';

const hud = document.getElementById('hud');
let timer = null;

window.clipshelf.onHud((msg) => {
  hud.className = `hud ${msg.kind || 'ok'}`;
  document.getElementById('title').textContent = msg.title || '';
  document.getElementById('body').textContent = msg.body || '';
  requestAnimationFrame(() => hud.classList.add('show'));
  clearTimeout(timer);
  timer = setTimeout(() => hud.classList.remove('show'), Math.max(600, (msg.durationMs || 1600) - 200));
});

const sounds = new Map();
window.clipshelf.onSound((spec) => {
  if (!spec || !spec.key) return;
  let a = sounds.get(spec.key);
  if (!a) {
    const src = spec.bundled ? `../../assets/sounds/${spec.bundled === 'paste' ? 'paste' : 'copy'}.wav` : spec.src;
    if (!src) return;
    a = new Audio(src);
    sounds.set(spec.key, a);
  }
  a.volume = Number.isFinite(Number(spec.volume)) ? Math.max(0, Math.min(1, Number(spec.volume))) : 0.6;
  a.currentTime = 0;
  a.play().catch(() => {});
});
