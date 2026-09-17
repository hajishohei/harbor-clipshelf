'use strict';
// Pure layout math for the Yoink-style shelf (unit-tested).

const WIDTH = 132;
const HEADER = 10;
const FOOTER = 30;
const ITEM = 96;
const EDGE_GAP = 0;
const VERTICAL_MARGIN = 24;

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

module.exports = { shelfGeometry, heightFor, SHELF_WIDTH: WIDTH, ITEM_HEIGHT: ITEM };
