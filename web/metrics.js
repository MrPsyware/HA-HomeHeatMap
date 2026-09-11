export const metrics = {
  temperature: { name: 'Temperature', unit: '°C', suffix: '°', min: 15, max: 28 },
  humidity: { name: 'Humidity', unit: '% RH', suffix: '%', min: 30, max: 80 },
  rssi: { name: 'Signal strength', unit: 'dBm', suffix: ' dBm', min: -100, max: -30, signal: true },
  lqi: { name: 'Zigbee link quality', unit: 'LQI (0–255)', suffix: ' LQI', min: 0, max: 255, signal: true },
};
export const metricOf = sensor => sensor.metric || 'temperature';
export function humidityPairs(layout, catalog) {
  const used = new Set([...layout.ignored, ...layout.floors.flatMap(f => f.sensors.map(s => s.entity_id))]);
  const stem = id => id.split('.').slice(1).join('.').replace(/_(?:temperature|tempreture|temp|relative_humidity|humidity|humid|moisture)$/, '');
  const proposals = [];
  for (const f of layout.floors) for (const p of f.sensors.filter(s => metricOf(s) === 'temperature')) {
    const source = catalog.find(s => s.entity_id === p.entity_id);
    const humidity = catalog.filter(s => s.metric === 'humidity');
    const device = source?.device_id ? humidity.filter(s => s.device_id === source.device_id) : [];
    const candidates = device.length ? device : humidity.filter(s => stem(s.entity_id) === stem(p.entity_id));
    // Ambiguous devices require manual placement; never choose an arbitrary sensor.
    if (candidates.length === 1 && !used.has(candidates[0].entity_id)) {
      proposals.push({ floor: f, source: p, sensor: candidates[0] }); used.add(candidates[0].entity_id);
    }
  }
  return proposals;
}
export function buildSignalField(sources, aspect = 1) {
  return {
    sources,
    weights(p) { return sources.map(s => 1 / Math.max(((p.x - s.point.x) * aspect) ** 2 + (p.y - s.point.y) ** 2, 1e-12)); },
    evaluate(weights, values) {
      let sum = 0, total = 0;
      sources.forEach((s, i) => { const value = values[s.entity_id]; if (Number.isFinite(value)) { sum += weights[i] * value; total += weights[i]; } });
      return total ? sum / total : null;
    },
  };
}
