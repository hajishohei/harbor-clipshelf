'use strict';
// Pure layout math for the Yoink-style shelf (unit-tested).

const WIDTH = 132;
const HEADER = 10;
const FOOTER = 30;
const ITEM = 96;
const EDGE_GAP = 0;
const VERTICAL_MARGIN = 24;
const TAB_WIDTH = 18;
const TAB_HEIGHT = 92;

function heightFor(size, count, maxHeight) {
  const n = Math.max(0, count);
  let rows;
  if (size === 'auto') rows = Math.max(3, n);
  else if (size === 'autoMin') rows = Math.max(1, n);
  else rows = 3;
  return Math.min(maxHeight, HEADER + FOOTER + rows * ITEM);
}

function clampInto(rect, areas) {
  const fits = (a) => rect.x >= a.x - rect.width / 2 && rect.x <= a.x + a.width - rect.width / 2 && rect.y >= a.y - 20 && rect.y <= a.y + a.height - 40;
  if (!areas || !areas.length || areas.some(fits)) return rect;
  return null;
}

// → { x, y, width, height }
function shelfGeometry({ workArea, position = 'left-center', size = 'default', count = 0, custom = null, allDisplays = null }) {
  const [side, align] = String(position).split('-');
  const maxHeight = workArea.height - VERTICAL_MARGIN * 2;
  const height = heightFor(size, count, maxHeight);
  if (custom) {
    const placed = clampInto({ x: Math.round(custom.x), y: Math.round(custom.y), width: WIDTH, height }, allDisplays);
    if (placed) return placed;
  }
  const x = side === 'right' ? workArea.x + workArea.width - WIDTH - EDGE_GAP : workArea.x + EDGE_GAP;
  let y;
  if (align === 'top') y = workArea.y + VERTICAL_MARGIN;
  else if (align === 'bottom') y = workArea.y + workArea.height - height - VERTICAL_MARGIN;
  else y = workArea.y + Math.round((workArea.height - height) / 2);
  return { x: Math.round(x), y: Math.round(y), width: WIDTH, height: Math.round(height) };
}

// Which vertical edge a shelf rectangle belongs to.
function sideOf(rect, workArea, position = 'left-center') {
  if (!rect) return String(position).startsWith('right') ? 'right' : 'left';
  const center = rect.x + rect.width / 2;
  return center > workArea.x + workArea.width / 2 ? 'right' : 'left';
}

// The slim tab the shelf collapses into while it is not being used.
function tabGeometry({ workArea, side = 'left', centerY }) {
  const cy = Number.isFinite(centerY) ? centerY : workArea.y + workArea.height / 2;
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - TAB_HEIGHT, Math.round(cy - TAB_HEIGHT / 2)));
  const x = side === 'right' ? workArea.x + workArea.width - TAB_WIDTH : workArea.x;
  return { x: Math.round(x), y, width: TAB_WIDTH, height: TAB_HEIGHT };
}

// A dragged-to position is remembered in absolute coordinates. When the shelf
// follows the user to another display, keep the same place relative to it.
function translatePoint(point, fromArea, toArea) {
  if (!point || !fromArea || !toArea) return point;
  const rx = fromArea.width ? (point.x - fromArea.x) / fromArea.width : 0;
  const ry = fromArea.height ? (point.y - fromArea.y) / fromArea.height : 0;
  const x = toArea.x + Math.round(Math.max(0, Math.min(1, rx)) * toArea.width);
  const y = toArea.y + Math.round(Math.max(0, Math.min(1, ry)) * toArea.height);
  return {
    x: Math.max(toArea.x, Math.min(toArea.x + toArea.width - WIDTH, x)),
    y: Math.max(toArea.y, Math.min(toArea.y + toArea.height - 120, y))
  };
}

function containsPoint(area, p) {
  return !!(area && p && p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height);
}

module.exports = {
  shelfGeometry, heightFor, tabGeometry, sideOf, translatePoint, containsPoint,
  SHELF_WIDTH: WIDTH, ITEM_HEIGHT: ITEM, TAB_WIDTH, TAB_HEIGHT
};
