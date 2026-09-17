'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/layouts');

const area = { x: 0, y: 25, width: 1441, height: 875 };
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1441, height: 900 }, workArea: area },
  { id: 2, bounds: { x: 1441, y: -200, width: 1920, height: 1080 }, workArea: { x: 1441, y: -200, width: 1920, height: 1040 } }
];

test('halves tile the work area exactly (odd widths too)', () => {
  const l = L.fractionRect(area, L.FRACTIONS.snapLeft);
  const r = L.fractionRect(area, L.FRACTIONS.snapRight);
  assert.equal(l.x, 0);
  assert.equal(l.width + r.width, area.width);
  assert.equal(r.x, l.x + l.width);
  assert.equal(l.y, 25);
  assert.equal(l.height, 875);
});

test('thirds and two-thirds line up', () => {
  const a = L.fractionRect(area, L.FRACTIONS.snapLeftThird);
  const b = L.fractionRect(area, L.FRACTIONS.snapCenterThird);
  const c = L.fractionRect(area, L.FRACTIONS.snapRightThird);
  assert.equal(a.width + b.width + c.width, area.width);
  assert.equal(b.x, a.x + a.width);
  assert.equal(c.x + c.width, area.x + area.width);
  const lt = L.fractionRect(area, L.FRACTIONS.snapLeftTwoThirds);
  assert.equal(lt.width, a.width + b.width);
  const rt = L.fractionRect(area, L.FRACTIONS.snapRightTwoThirds);
  assert.equal(rt.x, b.x);
  assert.equal(rt.x + rt.width, area.x + area.width);
});

test('quarters cover the area', () => {
  const tl = L.fractionRect(area, L.FRACTIONS.snapTopLeft);
  const br = L.fractionRect(area, L.FRACTIONS.snapBottomRight);
  assert.equal(tl.x + tl.width, br.x);
  assert.equal(tl.y + tl.height, br.y);
  assert.equal(br.x + br.width, area.x + area.width);
  assert.equal(br.y + br.height, area.y + area.height);
});

test('center keeps size and clamps to the area', () => {
  const c = L.centerRect(area, { x: 5, y: 40, width: 400, height: 300 });
  assert.deepEqual([c.width, c.height], [400, 300]);
  assert.equal(c.x, Math.round((1441 - 400) / 2));
  const huge = L.centerRect(area, { x: 0, y: 0, width: 5000, height: 5000 });
  assert.deepEqual(huge, { x: 0, y: 25, width: 1441, height: 875 });
});

test('pickDisplay chooses the display with the most overlap', () => {
  assert.equal(L.pickDisplay(displays, { x: 1300, y: 100, width: 400, height: 300 }).id, 2);
  assert.equal(L.pickDisplay(displays, { x: 100, y: 100, width: 400, height: 300 }).id, 1);
  assert.equal(L.pickDisplay(displays, { x: 9000, y: 9000, width: 10, height: 10 }).id, 2);
});

test('moving to next display keeps proportions and wraps around', () => {
  const frame = { x: 0, y: 25, width: 720, height: 437 };
  const moved = L.computeLayout('snapNextDisplay', { frame, displays });
  assert.equal(moved.x, 1441);
  assert.equal(moved.y, -200);
  assert.equal(moved.width, Math.round((720 / 1441) * 1920));
  const back = L.computeLayout('snapNextDisplay', { frame: moved, displays });
  assert.equal(back.x, 0);
  const prev = L.computeLayout('snapPrevDisplay', { frame, displays });
  assert.equal(prev.x, 1441);
  assert.equal(L.computeLayout('snapNextDisplay', { frame, displays: [displays[0]] }), null);
});

test('every action has a label', () => {
  for (const a of L.ACTIONS) assert.ok(L.LABELS[a], a);
});

test('sameRect tolerance', () => {
  assert.ok(L.sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: -2, width: 12, height: 9 }));
  assert.ok(!L.sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 0, width: 10, height: 10 }));
  assert.ok(!L.sameRect(null, { x: 0, y: 0, width: 1, height: 1 }));
});
