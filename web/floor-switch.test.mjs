import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('switching floors clears render state before tool changes redraw', async () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const selectFloor = source.slice(source.indexOf('async function selectFloor('), source.indexOf('async function loadImage('));
  const state = {
    image: {}, field: {}, cells: [{ room: 'ground-room' }],
    roomLabelPoints: new Map([['ground-room', { x: .5, y: .5 }]]),
    floorID: 'ground', historyRequest: 0, mode: 'live',
    stopPlay() {}, renderSidebar() {},
    setTool() {
      assert.equal(state.floorID, 'first');
      assert.equal(state.image, null);
      assert.equal(state.field, null);
      assert.equal(state.cells.length, 0);
      assert.equal(state.roomLabelPoints.size, 0);
    },
    async loadImage() { state.loaded = true; },
  };
  await runInNewContext(selectFloor + '\nselectFloor("first")', state);
  assert.equal(state.loaded, true);
});
