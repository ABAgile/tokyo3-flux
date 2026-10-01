// Edge auto-scroll speeds: how fast a scroller moves for a pointer near its edge.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = '../../internal/planningui/static/modules';
const { MAX_SPEED, axisSpeed, edgeSpeed } = await import(`${modules}/autoscroll.js`);

test('edge speed is zero outside the band and rises smoothly to the maximum', () => {
  assert.equal(edgeSpeed(0, 100), 0);
  assert.equal(edgeSpeed(-5, 100), 0);
  assert.equal(edgeSpeed(50, 0), 0);
  assert.equal(edgeSpeed(50, 100), MAX_SPEED / 4);
  assert.equal(edgeSpeed(100, 100), MAX_SPEED);
  assert.equal(edgeSpeed(400, 100), MAX_SPEED, 'beyond the edge is capped');
  assert.ok(edgeSpeed(30, 100) < edgeSpeed(60, 100) && edgeSpeed(60, 100) < edgeSpeed(90, 100));
});

test('axis speed scrolls toward the nearer edge and rests in the middle', () => {
  // A 600px scroller: bands are a fifth of it, 120px.
  assert.equal(axisSpeed(300, 0, 600), 0);
  assert.equal(axisSpeed(480, 0, 600), 0, 'the band starts exactly at its inner border');
  assert.ok(axisSpeed(540, 0, 600) > 0, 'end band scrolls forward');
  assert.ok(axisSpeed(60, 0, 600) < 0, 'start band scrolls back');
  assert.equal(axisSpeed(600, 0, 600), MAX_SPEED);
  assert.equal(axisSpeed(0, 0, 600), -MAX_SPEED);
  assert.equal(
    axisSpeed(540, 100, 700),
    axisSpeed(140, 0, 600),
    'depends on position within the scroller',
  );
});

test('bands stay between 48 and 120px and never overlap on small scrollers', () => {
  // 1000px scroller: band capped at 120px.
  assert.equal(axisSpeed(870, 0, 1000), 0);
  assert.ok(axisSpeed(890, 0, 1000) > 0);
  // 200px scroller: band is the 48px minimum.
  assert.equal(axisSpeed(151, 0, 200), 0);
  assert.ok(axisSpeed(160, 0, 200) > 0);
  // 60px scroller: halves of 30px, so the centre rests and each side moves.
  assert.equal(axisSpeed(30, 0, 60), 0);
  assert.ok(axisSpeed(10, 0, 60) < 0 && axisSpeed(50, 0, 60) > 0);
  assert.equal(axisSpeed(5, 10, 10), 0, 'an empty scroller does not move');
});
