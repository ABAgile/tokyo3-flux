// Where a card menu or its cascade is placed against the viewport.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = '../../internal/planningui/static/modules';
const { placeMenu } = await import(`${modules}/card-menu.js`);

const viewport = { width: 1000, height: 800 };
const box = (left, top, width = 28, height = 28) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const size = { width: 160, height: 80 };

test('a menu hangs below its button with the right edges aligned', () => {
  const at = placeMenu({ anchor: box(400, 100), size, viewport, beside: false });
  assert.deepEqual(at, { left: 428 - 160, top: 128 + 4 });
});

test('a menu opens above its button when there is no room below', () => {
  const at = placeMenu({ anchor: box(400, 740), size, viewport, beside: false });
  assert.equal(at.top, 740 - 4 - 80);
});

test('a menu below a button too high for either side still stays on screen', () => {
  const tall = { width: 160, height: 780 };
  const at = placeMenu({ anchor: box(400, 10), size: tall, viewport, beside: false });
  assert.ok(at.top >= 8 && at.top + 780 <= 800 - 8 + 0.5);
});

test('a menu is kept inside the left and right edges', () => {
  assert.equal(placeMenu({ anchor: box(2, 100), size, viewport, beside: false }).left, 8);
  const right = placeMenu({ anchor: box(990, 100), size, viewport, beside: false });
  assert.equal(right.left + 160, 1000 - 8);
});

test('a cascade opens to the right of its item, level with it', () => {
  const item = box(300, 200, 160, 32);
  assert.deepEqual(placeMenu({ anchor: item, size, viewport, beside: true }), {
    left: 460 + 4,
    top: 200 - 4,
  });
});

test('a cascade flips to the left of its item when the right has no room', () => {
  const item = box(780, 200, 160, 32);
  const at = placeMenu({ anchor: item, size, viewport, beside: true });
  assert.equal(at.left, 780 - 4 - 160);
});

test('a cascade is lifted when it would run past the bottom', () => {
  const item = box(300, 760, 160, 32);
  const at = placeMenu({ anchor: item, size, viewport, beside: true });
  assert.equal(at.top + 80, 800 - 8);
});

test('a menu can line up with the left edge of a button at the start of a row', () => {
  const at = placeMenu({ anchor: box(266, 100), size, viewport, beside: false, align: 'start' });
  assert.deepEqual(at, { left: 266, top: 128 + 4 });
  const near = placeMenu({ anchor: box(950, 100), size, viewport, beside: false, align: 'start' });
  assert.equal(near.left + 160, 1000 - 8, 'it still stays on screen');
});
