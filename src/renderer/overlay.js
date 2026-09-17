'use strict';

const api = window.clipshelf;
const shot = document.getElementById('shot');
const sel = document.getElementById('sel');
const size = document.getElementById('size');
let start = null;

api.screenOcrInit().then((data) => {
  if (data && data.image) shot.src = data.image;
});

function rect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function paint(r) {
  sel.hidden = false;
  sel.style.left = `${r.x}px`;
  sel.style.top = `${r.y}px`;
  sel.style.width = `${r.width}px`;
  sel.style.height = `${r.height}px`;
  size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    api.screenOcrCancel();
    return;
  }
  start = { x: e.clientX, y: e.clientY };
  document.body.classList.add('selecting');
  paint({ x: start.x, y: start.y, width: 0, height: 0 });
});

window.addEventListener('mousemove', (e) => {
  if (start) paint(rect(start, { x: e.clientX, y: e.clientY }));
});

window.addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  const r = rect(start, { x: e.clientX, y: e.clientY });
  start = null;
  if (r.width < 6 || r.height < 6) {
    sel.hidden = true;
    document.body.classList.remove('selecting');
    return;
  }
  api.screenOcrSelected(r);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.screenOcrCancel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.screenOcrCancel();
});
