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

test('collapsed tab hugs the chosen edge and stays on screen', () => {
  const { tabGeometry, TAB_WIDTH, TAB_HEIGHT } = require('../src/shared/shelfGeometry');
  const l = tabGeometry({ workArea: area, side: 'left', centerY: 400 });
  assert.equal(l.x, 0);
  assert.equal(l.width, TAB_WIDTH);
  assert.equal(l.y + TAB_HEIGHT / 2, 400);
  const r = tabGeometry({ workArea: area, side: 'right', centerY: 10 });
  assert.equal(r.x, 1440 - TAB_WIDTH);
  assert.equal(r.y, area.y);
  const b = tabGeometry({ workArea: area, side: 'right', centerY: 5000 });
  assert.equal(b.y + b.height, area.y + area.height);
});

test('side of a shelf rectangle', () => {
  const { sideOf } = require('../src/shared/shelfGeometry');
  assert.equal(sideOf({ x: 1300, y: 0, width: 132, height: 300 }, area), 'right');
  assert.equal(sideOf({ x: 10, y: 0, width: 132, height: 300 }, area), 'left');
  assert.equal(sideOf(null, area, 'right-top'), 'right');
});

test('dragged position follows to another display at the same relative place', () => {
  const { translatePoint, containsPoint } = require('../src/shared/shelfGeometry');
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  const p = translatePoint({ x: 720, y: 450 }, area, second);
  assert.ok(containsPoint(second, p));
  assert.equal(p.x, 1440 + 960);
  const edge = translatePoint({ x: 1439, y: 890 }, area, second);
  assert.ok(edge.x <= second.x + second.width - SHELF_WIDTH);
  assert.ok(containsPoint(second, edge));
});
