'use strict';
// Pure geometry for the Magnet-style window layouts (no Electron imports so
// it can be unit-tested). Rectangles are { x, y, width, height }.

// [x, y, width, height] as fractions of a display's work area.
const FRACTIONS = {
  snapLeft: [0, 0, 1 / 2, 1],
  snapRight: [1 / 2, 0, 1 / 2, 1],
  snapTop: [0, 0, 1, 1 / 2],
  snapBottom: [0, 1 / 2, 1, 1 / 2],
  snapTopLeft: [0, 0, 1 / 2, 1 / 2],
  snapTopRight: [1 / 2, 0, 1 / 2, 1 / 2],
  snapBottomLeft: [0, 1 / 2, 1 / 2, 1 / 2],
  snapBottomRight: [1 / 2, 1 / 2, 1 / 2, 1 / 2],
  snapLeftThird: [0, 0, 1 / 3, 1],
  snapCenterThird: [1 / 3, 0, 1 / 3, 1],
  snapRightThird: [2 / 3, 0, 1 / 3, 1],
  snapLeftTwoThirds: [0, 0, 2 / 3, 1],
  snapRightTwoThirds: [1 / 3, 0, 2 / 3, 1],
  snapMaximize: [0, 0, 1, 1]
};

const SPECIAL = ['snapCenter', 'snapRestore', 'snapNextDisplay', 'snapPrevDisplay'];
const ACTIONS = Object.keys(FRACTIONS).concat(SPECIAL);

const LABELS = {
  snapLeft: '左半分', snapRight: '右半分', snapTop: '上半分', snapBottom: '下半分',
  snapTopLeft: '左上 1/4', snapTopRight: '右上 1/4', snapBottomLeft: '左下 1/4', snapBottomRight: '右下 1/4',
  snapLeftThird: '左 1/3', snapCenterThird: '中央 1/3', snapRightThird: '右 1/3',
  snapLeftTwoThirds: '左 2/3', snapRightTwoThirds: '右 2/3',
  snapMaximize: '最大化', snapCenter: '中央に移動（サイズそのまま）', snapRestore: '整列前のサイズに戻す',
  snapNextDisplay: '次のディスプレイへ', snapPrevDisplay: '前のディスプレイへ'
};

function fractionRect(area, fr) {
  const [fx, fy, fw, fh] = fr;
  const x = area.x + Math.round(area.width * fx);
  const y = area.y + Math.round(area.height * fy);
  const right = area.x + Math.round(area.width * (fx + fw));
  const bottom = area.y + Math.round(area.height * (fy + fh));
  return { x, y, width: right - x, height: bottom - y };
}

function centerRect(area, frame) {
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  };
}

// Moves a window to another work area, keeping its relative position/size.
function moveToArea(frame, from, to) {
  const rx = (frame.x - from.x) / from.width;
  const ry = (frame.y - from.y) / from.height;
  const rw = frame.width / from.width;
  const rh = frame.height / from.height;
  const width = Math.min(to.width, Math.round(rw * to.width));
  const height = Math.min(to.height, Math.round(rh * to.height));
  let x = to.x + Math.round(rx * to.width);
  let y = to.y + Math.round(ry * to.height);
  x = Math.max(to.x, Math.min(x, to.x + to.width - width));
  y = Math.max(to.y, Math.min(y, to.y + to.height - height));
  return { x, y, width, height };
}

function intersectionArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function sameRect(a, b, tolerance = 4) {
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tolerance);
}

function contains(rect, point) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

// displays: [{ id, bounds, workArea }]. Picks the one the window overlaps most.
function pickDisplay(displays, frame) {
  let best = null;
  let bestArea = -1;
  for (const d of displays) {
    const area = intersectionArea(d.bounds, frame);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  if (bestArea > 0) return best;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  let nearest = displays[0];
  let nearestDist = Infinity;
  for (const d of displays) {
    const dx = d.bounds.x + d.bounds.width / 2 - cx;
    const dy = d.bounds.y + d.bounds.height / 2 - cy;
    const dist = dx * dx + dy * dy;
    if (dist < nearestDist) {
      nearest = d;
      nearestDist = dist;
    }
  }
  return nearest;
}

// Left-to-right, then top-to-bottom ordering for next/previous display.
function orderedDisplays(displays) {
  return displays.slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

function computeLayout(action, { frame, displays }) {
  const current = pickDisplay(displays, frame);
  if (FRACTIONS[action]) return fractionRect(current.workArea, FRACTIONS[action]);
  if (action === 'snapCenter') return centerRect(current.workArea, frame);
  if (action === 'snapNextDisplay' || action === 'snapPrevDisplay') {
    const list = orderedDisplays(displays);
    if (list.length < 2) return null;
    const idx = list.findIndex((d) => d.id === current.id);
    const step = action === 'snapNextDisplay' ? 1 : -1;
    const target = list[(idx + step + list.length) % list.length];
    return moveToArea(frame, current.workArea, target.workArea);
  }
  return null;
}

module.exports = {
  FRACTIONS, ACTIONS, LABELS, fractionRect, centerRect, moveToArea,
  intersectionArea, sameRect, contains, pickDisplay, orderedDisplays, computeLayout
};
