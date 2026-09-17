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

const sounds = {};
window.clipshelf.onSound((name) => {
  if (!sounds[name]) sounds[name] = new Audio(`../../assets/sounds/${name}.wav`);
  const a = sounds[name];
  a.volume = 0.6;
  a.currentTime = 0;
  a.play().catch(() => {});
});
