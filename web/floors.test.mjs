import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFloor } from './floors.js';

test('floor links accept case-insensitive names and retain exact ID precedence', () => {
  const floors = [{ id: 'ground', name: 'Downstairs' }, { id: 'first', name: 'Upstairs' }];
  for (const name of ['upstairs', 'UPSTAIRS', ' Upstairs ']) assert.equal(findFloor(floors, name), floors[1]);
  assert.equal(findFloor(floors, 'first'), floors[1]);
  assert.equal(findFloor(floors, 'missing'), undefined);
  assert.equal(findFloor(floors, null), undefined);
  assert.equal(findFloor([...floors, { id: 'upstairs', name: 'Other' }], 'upstairs').name, 'Other');
});
