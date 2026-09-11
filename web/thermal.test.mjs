import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inside, visible, buildField, valueAt } from './thermal.js';
const polygon = (left, right) => [{ x: left, y: 0 }, { x: right, y: 0 }, { x: right, y: 1 }, { x: left, y: 1 }];
const source = (id, x, room = 'a') => ({ entity_id: id, room_id: room, point: { x, y: .5 } });
const fixture = () => ({ rooms: [{ id: 'a', polygon: polygon(0, .5) }, { id: 'b', polygon: polygon(.5, 1) }], sensors: [source('cold', .1), source('hot', .4)], doors: [] });
test('gradient honours sensor positions and cannot pass through an unconnected wall', () => {
 const field = buildField(fixture()); const values = { cold: 16, hot: 24 };
 assert.ok(Math.abs(field.evaluate(field.weights({ x: .1, y: .5 }, 'a'), values) - 16) < 1e-6);
 assert.ok(Math.abs(field.evaluate(field.weights({ x: .25, y: .5 }, 'a'), values) - 20) < 1e-6);
 assert.equal(field.evaluate(field.weights({ x: .75, y: .5 }, 'b'), values), null);
});
test('doorways reach sensorless rooms, and zero influence blocks them', () => {
 const floor = fixture(); floor.doors.push({ room_a: 'a', room_b: 'b', a: { x: .49, y: .5 }, b: { x: .51, y: .5 }, influence: .35 });
 let field = buildField(floor); const value = field.evaluate(field.weights({ x: .75, y: .5 }, 'b'), { cold: 16, hot: 24 }); assert.ok(value > 16 && value < 24);
 assert.equal(field.evaluate(field.weights({ x: .75, y: .5 }, 'b'), { cold: null, hot: null }), null);
 floor.doors[0].influence = 0; field = buildField(floor); assert.equal(field.evaluate(field.weights({ x: .75, y: .5 }, 'b'), { cold: 16, hot: 24 }), null);
});
test('visibility paths respect concave rooms', () => {
 const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: .3 }, { x: .3, y: .3 }, { x: .3, y: 1 }, { x: 0, y: 1 }];
 assert.equal(inside({ x: .8, y: .8 }, poly), false);
 assert.equal(visible({ x: .9, y: .1 }, { x: .1, y: .9 }, poly), false);
 assert.equal(visible({ x: .9, y: .1 }, { x: .3, y: .3 }, poly), true);
});
test('history never fills gaps or unavailable readings', () => {
 const rows = [{ start: 10, end: 20, value: 18 }, { start: 20, end: 30, value: null }, { start: 40, end: 50, value: 22 }];
 assert.equal(valueAt(rows, 9), null); assert.equal(valueAt(rows, 10), 18); assert.equal(valueAt(rows, 20), null); assert.equal(valueAt(rows, 35), null); assert.equal(valueAt(rows, 40), 22); assert.equal(valueAt(rows, 50), null);
});
