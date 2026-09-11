import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humidityPairs, buildSignalField, metricOf } from './metrics.js';
const placement = entity_id => ({ entity_id, room_id: 'room', point: {x:.2,y:.4} });
const layout = ids => ({ignored:[],floors:[{sensors:ids.map(placement)}]});
test('legacy placements remain temperature and humidity pairing prefers same device', () => {
 const l = layout(['sensor.lounge_temp']);
 assert.equal(metricOf(l.floors[0].sensors[0]), 'temperature');
 const pairs = humidityPairs(l, [
  {entity_id:'sensor.lounge_temp', device_id:'device'},
  {entity_id:'sensor.renamed_humidity', device_id:'device', metric:'humidity'},
  {entity_id:'sensor.lounge_humidity', device_id:'other', metric:'humidity'},
 ]);
 assert.equal(pairs[0].sensor.entity_id, 'sensor.renamed_humidity');
 assert.equal(pairs[0].source.point.x, .2);
});
test('prefix fallback accepts common temperature spellings and never duplicates or restores ignored sensors', () => {
 for (const suffix of ['temperature','tempreture','temp']) {
  const l=layout(['sensor.lounge_'+suffix]);
  const catalog=[{entity_id:'sensor.lounge_humidity',metric:'humidity'}];
  assert.equal(humidityPairs(l,catalog).length,1);
  l.ignored.push(catalog[0].entity_id);
  assert.equal(humidityPairs(l,catalog).length,0);
  l.ignored=[]; l.floors.push({sensors:[{entity_id:catalog[0].entity_id,metric:'humidity'}]});
  assert.equal(humidityPairs(l,catalog).length,0);
 }
});
test('ambiguous humidity sensors on a device are not paired automatically', () => {
 const l=layout(['sensor.air_temp']);
 assert.equal(humidityPairs(l,[
  {entity_id:'sensor.air_temp',device_id:'d'},
  {entity_id:'sensor.air_humidity',device_id:'d',metric:'humidity'},
  {entity_id:'sensor.other_humidity',device_id:'d',metric:'humidity'},
 ]).length,0);
});
test('signal crosses room boundaries, honours image aspect and excludes unavailable values', () => {
 const f=buildSignalField([{entity_id:'a',point:{x:0,y:0}},{entity_id:'b',point:{x:1,y:0}}],2);
 assert.equal(f.evaluate(f.weights({x:.5,y:.5}),{a:-90,b:-30}),-60);
 assert.equal(f.evaluate(f.weights({x:.5,y:.5}),{a:null,b:-30}),-30);
 assert.equal(f.evaluate(f.weights({x:.5,y:.5}),{}),null);
 assert.ok(Math.abs(f.evaluate(f.weights({x:0,y:0}),{a:-90,b:-30})+90)<1e-6);
});
