'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shelfGeometry, heightFor, SHELF_WIDTH, ITEM_HEIGHT } = require('../src/shared/shelfGeometry');

const area = { x: 0, y: 25, width: 1440, height: 875 };

test('six Yoink positions', () => {
  const g = (position) => shelfGeometry({ workArea: area, position, size: 'default', count: 0 });
  assert.equal(g('left-top').x, 0);
  assert.equal(g('right-top').x, 1440 - SHELF_WIDTH);
  assert.ok(g('left-top').y < g('left-center').y && g('left-center').y < g('left-bottom').y);
  const b = g('right-bottom');
  assert.ok(b.y + b.height <= area.y + area.height);
  const c = g('left-center');
  assert.equal(Math.round(c.y + c.height / 2), Math.round(area.y + area.height / 2));
});

test('window sizes: default 3 items, auto grows from 3, autoMin grows from 1', () => {
  const max = 800;
  assert.equal(heightFor('default', 10, max), heightFor('default', 0, max));
  assert.equal(heightFor('auto', 1, max), heightFor('auto', 3, max));
  assert.equal(heightFor('auto', 4, max) - heightFor('auto', 3, max), ITEM_HEIGHT);
  assert.ok(heightFor('autoMin', 1, max) < heightFor('auto', 1, max));
  assert.equal(heightFor('auto', 100, max), max);
});

test('custom (dragged) position is used while it is on a screen', () => {
  const custom = { x: 500, y: 300 };
  const g = shelfGeometry({ workArea: area, position: 'left-top', custom, allDisplays: [area] });
  assert.equal(g.x, 500);
  assert.equal(g.y, 300);
  const off = shelfGeometry({ workArea: area, position: 'left-top', custom: { x: 5000, y: 300 }, allDisplays: [area] });
  assert.equal(off.x, 0, 'falls back when the display is gone');
});
