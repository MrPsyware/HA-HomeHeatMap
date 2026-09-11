import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomLabelPoint } from './labels.js';
import { inside } from './thermal.js';

test('L-shaped label stays in the body away from the reentrant boundary', () => {
  const poly = [[0,0],[1,0],[1,.3],[.4,.3],[.4,1],[0,1]].map(([x,y]) => ({x,y}));
  const p = roomLabelPoint(poly);
  assert.ok(inside(p, poly));
  assert.ok(p.x > .15 && p.x < .25);
  assert.ok(p.y > .15 && p.y < .85);
});
test('square image-space room label is centred with a non-square image', () => {
  const poly = [[0,0],[.5,0],[.5,1],[0,1]].map(([x,y]) => ({x,y}));
  const p = roomLabelPoint(poly, 2);
  assert.ok(Math.abs(p.x - .25) < .001);
  assert.ok(Math.abs(p.y - .5) < .001);
});
