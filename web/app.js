import { metrics, metricOf, humidityPairs, buildSignalField } from './metrics.js';
import { roomLabelPoint } from './labels.js';
import { findFloor } from './floors.js';
import { startTheme } from './theme.js';
import { inside, buildField, valueAt, colour } from './thermal.js';

const params = new URLSearchParams(location.search), minimal = params.get('minimal') === '1', embedded = minimal || params.get('embed') === '1';
const compactDevices = minimal || (embedded && params.get('device_labels') !== '1');
const allowedMetrics = (params.get('metrics') || 'temperature,humidity,rssi,lqi').split(',').filter(m => metrics[m]);
if (!allowedMetrics.length) allowedMetrics.push('temperature');
let metric = allowedMetrics[0], hovered = '', movingReference = '';
const signal = () => !!metrics[metric].signal;
const $ = id => document.getElementById(id);
let layout = { version: 1, revision: 0, floors: [], ignored: [] }, catalog = { sensors: [], floors: [] };
let floorID = '', setup = false, mode = 'live', tool = 'select', draft = [], doorStart = null, selectedSensor = '';
let image = null, field = null, cells = [], currentValues = {}, liveValues = {}, history = null, historyRequest = 0;
let changes = 0, sourceEpoch = 0;
let gridWidth = 1, gridHeight = 1;
let roomLabelPoints = new Map();
let labelTheme = { background: '#202124', text: '#e8eaed' };
const heatCanvas = document.createElement('canvas'), heatCtx = heatCanvas.getContext('2d');
let dirty = false, demo = false, configured = false, zoom = 1, playing = null, lastLive = 0, imageRequest = 0, busy = false;
const canvas = $('map'), ctx = canvas.getContext('2d');
const floor = () => layout.floors.find(f => f.id === floorID);
const id = () => crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const format = value => Number.isFinite(value) ? `${value.toFixed(metric === 'temperature' ? 1 : 0)}${metrics[metric].suffix}` : '—';
const activeSensors = () => (floor()?.sensors || []).filter(s => metricOf(s) === metric && (!signal() || !$('network').value || (s.network || catalog.sensors.find(c => c.entity_id === s.entity_id)?.network || 'unknown') === $('network').value));
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'X-Heatmap-Request': '1', ...options.headers } });
  const result = await res.json(); if (!res.ok) throw Error(result.error || `Request failed (${res.status})`); return result;
}
function run(fn) { return async (...args) => { try { await fn(...args); } catch (e) { notice(e.message); } }; }
function button(text, action, className = '') { const b = document.createElement('button'); b.textContent = text; b.className = className; b.onclick = run(action); return b; }
function text(tag, value, className = '') { const el = document.createElement(tag); el.textContent = value; el.className = className; return el; }
function markDirty(geometry = true) { changes++; dirty = true; $('save-state').textContent = demo ? 'Demo changes stay in this tab' : 'Unsaved changes'; if (geometry) rebuild(); renderSidebar(); }
function options(select, list, value = '') { select.replaceChildren(); for (const [id, name] of list) { const o = document.createElement('option'); o.value = id; o.textContent = name; select.append(o); } select.value = value; }
function floorOptions(select, value = '') { const entries = [['', 'Choose later'], ...catalog.floors.map(f => [f.floor_id, f.name])]; if (value && !entries.some(e => e[0] === value)) entries.push([value, `${value} (not currently available)`]); options(select, entries, value); }

function renderSidebar() {
  $('floor-list').replaceChildren(...layout.floors.map(f => { const b = button(f.name, () => selectFloor(f.id), f.id === floorID ? 'active' : ''); b.append(text('span', `${f.rooms.length} rooms`, 'muted')); return b; }));
  $('setup-panel').hidden = !setup || !floor(); $('view-panel').hidden = setup;
  $('import-controls').hidden = !setup || demo;
  $('import-setup').disabled = busy;
  $('save').hidden = !setup; $('save').disabled = demo || !dirty || busy;
  $('add-floor').hidden = !setup && layout.floors.length > 0;
  if (!floor()) return;
  options($('embed-floor'), layout.floors.map(f => [f.id, f.name]), floorID);
  const f = floor(); $('map-title').textContent = f.name;
  if (document.activeElement !== $('floor-name')) $('floor-name').value = f.name;
  floorOptions($('ha-floor'), f.ha_floor_id);
  renderSensors(); renderGeometry(); renderRoomValues();
}
function renderRoomValues() {
  if (!floor()) return;
  $('room-list').replaceChildren(...floor().rooms.map(r => {
    const sampleCells = cells.filter(c => c.room === r.id), readings = sampleCells.map(c => field.evaluate(c.weights, currentValues)).filter(Number.isFinite);
    const avg = readings.length ? readings.reduce((a, b) => a + b, 0) / readings.length : null;
    const count = activeSensors().filter(s => s.room_id === r.id && Number.isFinite(currentValues[s.entity_id])).length;
    const el = text('div', '', 'room-card'), info = text('div', r.name); info.append(text('small', signal() ? 'Signal interpolation · rooms do not block it' : count ? `${count} sensor${count > 1 ? 's' : ''} · spatial average` : readings.length ? 'Estimated through doorways' : 'No data')); el.append(info, text('strong', format(avg))); return el;
  }));
}
function renderSensors() {
  const query = $('sensor-search').value.toLowerCase(), f = floor();
  const sensors = catalog.sensors.filter(s => metricOf(s) === metric);
  for (const p of activeSensors()) if (!sensors.some(s => s.entity_id === p.entity_id)) sensors.push({ entity_id: p.entity_id, name: p.entity_id, metric, value: null });
  sensors.sort((a, b) => Number(b.floor_id === f.ha_floor_id && !!f.ha_floor_id) - Number(a.floor_id === f.ha_floor_id && !!f.ha_floor_id));
  $('sensor-list').replaceChildren(...sensors.filter(s => {
    const placedHere = f.sensors.some(p => p.entity_id === s.entity_id);
    const filter = $('device-filter').value;
    if (filter === 'floor' && f.ha_floor_id && s.floor_id !== f.ha_floor_id && !placedHere) return false;
    if (filter === 'unplaced' && layout.floors.some(f => f.sensors.some(p => p.entity_id === s.entity_id))) return false;
    const network = f.sensors.find(p => p.entity_id === s.entity_id)?.network || s.network || 'unknown';
    if (signal() && $('network').value && network !== $('network').value) return false;
    return `${s.name} ${s.entity_id}`.toLowerCase().includes(query) && ($('show-ignored').checked || !layout.ignored.includes(s.entity_id)); }).map(s => {
    const placedFloor = layout.floors.find(f => f.sensors.some(p => p.entity_id === s.entity_id));
    const placed = placedFloor?.sensors.find(p => p.entity_id === s.entity_id), ignored = layout.ignored.includes(s.entity_id);
    const el = text('div', '', 'sensor');
    el.append(button(`${s.name}  ${format(currentValues[s.entity_id])}`, () => {
      if (ignored) { notice('Restore this sensor before placing it.'); return; }
      if (placedFloor && placedFloor.id !== f.id) { notice(`This sensor is placed on ${placedFloor.name}. Remove it there before moving it to this floor.`); return; }
      selectedSensor = s.entity_id; setTool('sensor'); renderSensors();
    }, selectedSensor === s.entity_id ? 'active' : ''));
    el.draggable = !ignored && (!placedFloor || placedFloor.id === f.id);
    el.ondragstart = e => { e.dataTransfer.setData('text/plain', s.entity_id); e.dataTransfer.effectAllowed = 'move'; };
    el.append(text('small', s.entity_id));
    if (signal() && placed) {
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Device network');
      options(select, [['', 'Auto / unclassified'], ['wifi', 'Wi-Fi'], ['zigbee', 'Zigbee']], placed.network || '');
      select.onchange = () => { placed.network = select.value; markDirty(); }; el.append(select);
    }
    const row = text('div', '', 'row');
    row.append(text('span', ignored ? 'Ignored' : placed ? `${placedFloor.name} · ${placedFloor.rooms.find(r => r.id === placed.room_id)?.name || 'On floor plan'}` : s.floor_id === f.ha_floor_id && !!f.ha_floor_id ? 'Suggested for this floor' : 'Unplaced', 'muted'));
    if (placed) row.append(button('Remove', () => { placedFloor.sensors = placedFloor.sensors.filter(p => p.entity_id !== s.entity_id); markDirty(); }));
    else row.append(button(ignored ? 'Restore' : 'Ignore', () => { layout.ignored = ignored ? layout.ignored.filter(e => e !== s.entity_id) : [...layout.ignored, s.entity_id]; if (selectedSensor === s.entity_id) setTool('select'); markDirty(false); }));
    el.append(row); return el;
  }));
  if (!$('sensor-list').children.length) $('sensor-list').append(text('p', configured || demo ? 'No matching sensors.' : 'Set HA_URL and HA_TOKEN to discover sensors. You can draw rooms now or explore the demo.', 'hint'));
}
function renderGeometry() {
  $('reference-list').replaceChildren(...(floor().references || []).map(ref => {
    const row = text('div', '', 'geometry');
    row.append(button(ref.name, () => { movingReference = ref.id; setTool('reference'); }), button('Remove', () => { floor().references = floor().references.filter(r => r.id !== ref.id); markDirty(); })); return row;
  }));
  const f = floor(); $('geometry-list').replaceChildren();
  for (const r of f.rooms) {
    const row = text('div', '', 'geometry'); row.append(text('span', r.name), button('Remove', () => {
      if (!confirm(`Remove ${r.name}, its sensor placements and connected doorways?`)) return;
      f.rooms = f.rooms.filter(x => x.id !== r.id); f.sensors = f.sensors.filter(x => x.room_id !== r.id); f.doors = f.doors.filter(d => d.room_a !== r.id && d.room_b !== r.id); markDirty();
    })); $('geometry-list').append(row);
  }
  for (const d of f.doors) {
    const row = text('div', '', 'geometry'), names = `${f.rooms.find(r => r.id === d.room_a)?.name} ↔ ${f.rooms.find(r => r.id === d.room_b)?.name}`;
    const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 1; range.step = .05; range.value = d.influence; range.title = names; range.setAttribute('aria-label', `Influence: ${names}`); range.onchange = () => { d.influence = Number(range.value); markDirty(); };
    row.append(text('span', names), range, button('×', () => { f.doors = f.doors.filter(x => x.id !== d.id); markDirty(); })); $('geometry-list').append(row);
  }
}

function setTool(next) {
  tool = next; draft = []; doorStart = null;
  if (next !== 'sensor') selectedSensor = '';
  for (const t of ['room', 'door', 'select']) $(`${t}-tool`).classList.toggle('active', t === next);
  $('room-controls').hidden = next !== 'room'; $('door-controls').hidden = next !== 'door';
  $('tool-hint').textContent = { room: 'Click each corner of the room. Click within 12 pixels of the first corner to close, or use Finish room below. Escape cancels; Backspace removes the last point.', door: 'Click just inside a room at a doorway, then just inside the adjoining room. This connects the two rooms across the wall.', reference: 'Click the map to place the reference marker.', sensor: 'Click inside the room to place this sensor. Click its name again to move it.', select: 'Select a sensor to move it, or use the room and doorway tools. Remove geometry below to redraw it.' }[next];
  draw();
}
function setSetup(value) {
  if (embedded) value = false;
  setup = value; $('setup-toggle').classList.toggle('active', setup); $('setup-toggle').textContent = setup ? 'Done editing' : 'Setup';
  if (setup) setMode('live'); else setTool('select');
  renderSidebar(); draw();
}
async function selectFloor(next) {
  // Tool changes redraw immediately: discard the previous floor's geometry first.
  image = null; field = null; cells = []; roomLabelPoints = new Map();
  floorID = next; setTool('select'); zoom = 1; history = null; historyRequest++; stopPlay();
  await loadImage(); renderSidebar();
  if (mode === 'history') await loadHistory();
}
async function loadImage() {
  const request = ++imageRequest; field = null; cells = []; image = null;
  $('empty').hidden = !!floor(); canvas.hidden = !floor();
  if (!floor()) return;
  const src = demo ? demoImage() : floor().image;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(Error('Could not load the floor plan image.')); img.src = src; });
  if (request !== imageRequest) return;
  image = img; rebuild();
}
function rebuild() {
  if (!image || !floor()) return;
  field = signal() ? buildSignalField(activeSensors(), image.width / image.height) : buildField({ ...floor(), sensors: activeSensors() }, image.width / image.height);
  cells = [];
  // Cache geometry weights once. Scrubbing only multiplies new sensor values.
  const aspect = image.width / image.height, ny = Math.round(85 / Math.sqrt(aspect)), nx = Math.round(ny * aspect);
  gridWidth = nx; gridHeight = ny; heatCanvas.width = nx; heatCanvas.height = ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = { x: (x + .5) / nx, y: (y + .5) / ny }, room = floor().rooms.find(r => inside(p, r.polygon));
    if (room || signal()) cells.push({ ix: x, iy: y, x: x / nx, y: y / ny, w: 1 / nx, h: 1 / ny, room: room?.id || '', weights: field.weights(p, room?.id) });
  }
  roomLabelPoints = new Map(floor().rooms.map(r => [r.id, roomLabelPoint(r.polygon, aspect)]));
  resize(); renderRoomValues();
}
function resize() {
  if (!image) return;
  const viewport = $('viewport'), padding = minimal ? 0 : 56, fit = Math.min((viewport.clientWidth - padding) / image.width, (viewport.clientHeight - padding) / image.height);
  const width = Math.max(100, image.width * fit * zoom), height = width * image.height / image.width;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  $('zoom-label').textContent = `${Math.round(zoom * 100)}%`; draw();
}
function path(poly, w, h) { ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)); ctx.closePath(); }
function draw() {
  if (!image || !floor() || !field) return;
  const w = canvas.width, h = canvas.height, unit = Math.max(1, w / 850), f = floor();
  ctx.clearRect(0, 0, w, h); ctx.drawImage(image, 0, 0, w, h);
  const min = Number($('scale-min').value), max = Number($('scale-max').value), opacity = Number($('opacity').value);
  if (signal()) {
    const pixels = heatCtx.createImageData(gridWidth, gridHeight);
    for (const c of cells) {
      const value = field.evaluate(c.weights, currentValues);
      if (Number.isFinite(value)) pixels.data.set([...colour(value, min, max), Math.round(opacity * 255)], (c.iy * gridWidth + c.ix) * 4);
    }
    heatCtx.putImageData(pixels, 0, 0); ctx.drawImage(heatCanvas, 0, 0, w, h);
  }
  for (const r of f.rooms) {
    if (signal()) { const p = roomLabelPoints.get(r.id); label(r.name, p.x * w, p.y * h, unit, false); continue; }
    ctx.save(); path(r.polygon, w, h); ctx.clip();
    const pixels = heatCtx.createImageData(gridWidth, gridHeight);
    let total = 0, readingCount = 0;
    for (const c of cells) if (c.room === r.id) {
      const value = field.evaluate(c.weights, currentValues), valid = Number.isFinite(value);
      if (valid) { total += value; readingCount++; }
      const rgb = valid ? colour(value, min, max) : [127, 139, 129], offset = (c.iy * gridWidth + c.ix) * 4;
      pixels.data.set([...rgb, Math.round((valid ? opacity : .14) * 255)], offset);
    }
    heatCtx.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(heatCanvas, 0, 0, w, h);
    ctx.restore();
    const measured = activeSensors().some(s => s.room_id === r.id && Number.isFinite(currentValues[s.entity_id]));
    ctx.save(); path(r.polygon, w, h); ctx.strokeStyle = setup ? '#497554' : '#50634c88'; ctx.lineWidth = unit * (setup ? 2 : 1); ctx.setLineDash(measured ? [] : [5 * unit, 4 * unit]); ctx.stroke(); ctx.restore();
    const p = roomLabelPoints.get(r.id);
    const average = readingCount ? total / readingCount : null;
    label([r.name, format(average)], p.x * w, p.y * h, unit, false, !measured && readingCount > 0);
  }
  for (const d of signal() || embedded ? [] : f.doors) {
    ctx.save(); ctx.strokeStyle = d.influence > 0 ? '#347d70' : '#888'; ctx.lineWidth = 5 * unit; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(d.a.x * w, d.a.y * h); ctx.lineTo(d.b.x * w, d.b.y * h); ctx.stroke(); ctx.restore();
  }
  for (const s of minimal ? [] : activeSensors()) {
    const value = currentValues[s.entity_id], x = s.point.x * w, y = s.point.y * h;
    if (!compactDevices || hovered === s.entity_id) {
    ctx.fillStyle = Number.isFinite(value) ? `rgb(${colour(value, min, max)})` : '#929c92'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * unit; ctx.beginPath(); ctx.arc(x, y, (signal() ? 3 : 6) * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if ((!signal() && !compactDevices) || hovered === s.entity_id || selectedSensor === s.entity_id) label((signal() || compactDevices) ? [catalog.sensors.find(c => c.entity_id === s.entity_id)?.name || s.entity_id, format(value)] : format(value), x, y - 18 * unit, unit, true);
  }
  if (signal() && !compactDevices) for (const ref of f.references || []) {
    label([ref.kind === 'wifi' ? '⌁ AP' : '◇ Zigbee', ref.name], ref.point.x * w, ref.point.y * h, unit, true);
  }
  if (draft.length) { ctx.beginPath(); draft.forEach((p, i) => { i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h); }); ctx.strokeStyle = '#246c49'; ctx.lineWidth = 2 * unit; ctx.stroke(); for (const p of draft) { ctx.fillStyle = '#246c49'; ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 4 * unit, 0, Math.PI * 2); ctx.fill(); } }
  if (doorStart) label('Click adjoining room', doorStart.point.x * w, doorStart.point.y * h, unit, true);
}
function label(value, x, y, unit, filled, estimated = false) {
  ctx.save();
  const font = `${filled ? 600 : 500} ${11 * unit}px system-ui`;
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = Array.isArray(value) ? value : [value];
  const lineHeight = 15 * unit, height = (lines.length - 1) * lineHeight + 20 * unit;
  const widths = lines.map(line => ctx.measureText(line).width);
  ctx.font = `500 ${8 * unit}px system-ui`;
  const starWidth = estimated ? ctx.measureText('*').width + unit : 0;
  ctx.font = font;
  const width = Math.max(...widths.map((width, i) => width + (i === 0 ? starWidth : 0))) + 14 * unit;
  ctx.fillStyle = labelTheme.background; ctx.beginPath(); ctx.roundRect(x - width / 2, y - height / 2, width, height, 5 * unit); ctx.fill(); ctx.fillStyle = labelTheme.text;
  lines.forEach((line, i) => {
    const lineY = y + (i - (lines.length - 1) / 2) * lineHeight;
    ctx.fillText(line, x - (i === 0 ? starWidth / 2 : 0), lineY);
    if (i === 0 && estimated) {
      ctx.font = `500 ${8 * unit}px system-ui`; ctx.textAlign = 'left';
      ctx.fillText('*', x + (widths[0] - starWidth) / 2 + unit, lineY - 2 * unit);
      ctx.font = font; ctx.textAlign = 'center';
    }
  });
  ctx.restore();
}
canvas.onclick = run(e => {
  if (minimal) return;
  if (!setup && floor()) { hovered = hitSensor(e)?.entity_id || ''; draw(); return; }
  if (!setup || !floor()) return;
  const rect = canvas.getBoundingClientRect(), p = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }, f = floor();
  if (tool === 'room') {
    if (draft.length >= 3 && Math.hypot((p.x - draft[0].x) * rect.width, (p.y - draft[0].y) * rect.height) <= 12) {
      finishRoom();
    } else { draft.push(p); draw(); }
    return;
  }
  const r = f.rooms.find(r => inside(p, r.polygon));
  if (tool === 'sensor') {
    placeSensor(selectedSensor, p);
  } else if (tool === 'reference') {
    const refs = f.references ||= [], existing = refs.find(r => r.id === movingReference);
    if (existing) existing.point = p;
    else {
      const name = $('reference-name').value.trim(); if (!name) { notice('Give the reference marker a name.'); return; }
      refs.push({ id: id(), name, kind: $('reference-kind').value, point: p });
    }
    movingReference = ''; setTool('select'); markDirty();
  } else if (tool === 'door') {
    if (!r) { notice('Click just inside a room at the doorway.'); return; }
    if (!doorStart) { doorStart = { room: r.id, point: p }; draw(); }
    else { if (r.id === doorStart.room) { notice('The second endpoint must be inside a different room.'); return; } f.doors.push({ id: id(), room_a: doorStart.room, room_b: r.id, a: doorStart.point, b: p, influence: Number($('door-influence').value) }); doorStart = null; notice(); markDirty(); }
  } else {
    const s = activeSensors().find(s => Math.hypot((s.point.x - p.x) * rect.width, (s.point.y - p.y) * rect.height) < 18);
    if (s) { selectedSensor = s.entity_id; setTool('sensor'); renderSensors(); }
  }
});

function setMode(next) {
  if (minimal) next = 'live';
  mode = next; stopPlay(); $('live-button').classList.toggle('active', next === 'live'); $('history-button').classList.toggle('active', next === 'history'); $('timeline').hidden = next !== 'history';
  $('map-mode').textContent = next === 'live' ? `Live · ${metrics[metric].name}` : `History · ${metrics[metric].name}`;
  if (next === 'live') { historyRequest++; currentValues = liveValues; draw(); renderRoomValues(); }
  else { if (setup) setSetup(false); currentValues = {}; draw(); renderRoomValues(); }
}
async function refreshLive() {
  const epoch = sourceEpoch;
  if (demo) { liveValues = demoValues(Date.now()); }
  else if (configured) { const sensors = await api('api/live'); if (epoch !== sourceEpoch) return; liveValues = Object.fromEntries(sensors.map(s => [s.entity_id, s.value])); }
  else return;
  lastLive = Date.now(); $('connection').textContent = demo ? 'Demo · simulated data' : 'Connected · live';
  if (mode === 'live') { currentValues = liveValues; draw(); renderRoomValues(); }
}
async function loadCatalog() {
  if (!configured || demo) return;
  const epoch = sourceEpoch;
  const result = await api('api/catalog').catch(e => { if (epoch === sourceEpoch) $('connection').textContent = 'HA disconnected'; throw e; }); if (epoch !== sourceEpoch) return; catalog = result; liveValues = Object.fromEntries(catalog.sensors.map(s => [s.entity_id, s.value]));
  lastLive = Date.now(); if (mode === 'live') currentValues = liveValues;
  $('connection').textContent = 'Connected · live'; renderSidebar(); draw();
  if (result.warnings.length) notice(result.warnings.join(' · '));
}
async function loadHistory() {
  stopPlay(); const request = ++historyRequest; history = null; currentValues = {}; draw(); renderRoomValues(); $('scrub').disabled = true;
  if (!floor()) return;
  if (!demo && dirty) { notice('Save setup before loading history so HA uses the latest sensor placements.'); return; }
  const end = new Date($('history-end').value), days = Number($('range').value), start = new Date(end.getTime() - days * 86400000);
  if (!Number.isFinite(end.getTime())) throw Error('Choose a valid history end time.');
  $('history-resolution').textContent = 'Loading history…'; $('history-warning').textContent = ''; $('load-history').disabled = true;
  try {
    const next = demo ? demoHistory(start, end, days) : await api(`api/history?${new URLSearchParams({ floor: floorID, start: start.toISOString(), end: end.toISOString(), resolution: $('history-detail').value, metric })}`);
    if (request !== historyRequest || mode !== 'history') return;
    history = next; $('scrub').disabled = false; $('scrub').value = 1000;
    $('range-start').textContent = start.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); $('range-end').textContent = end.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    $('history-resolution').textContent = `${demo ? 'Demo · ' : ''}${history.resolution === 'hour' ? 'Hourly means' : 'Recorded state changes'}`;
    $('history-warning').textContent = history.warnings.join(' · ') || (history.resolution === 'hour' ? 'Each colour represents an hourly mean. Empty intervals stay blank; not every sensor records long-term statistics.' : 'Unavailable readings and missing history remain blank.');
    scrub();
  } catch (e) { if (request === historyRequest) { $('history-resolution').textContent = 'History unavailable'; throw e; } }
  finally { $('load-history').disabled = false; }
}
function scrub() {
  if (!history) return;
  const stamp = Math.min(history.end - 1, history.start + (history.end - history.start) * Number($('scrub').value) / 1000);
  currentValues = Object.fromEntries(Object.entries(history.series).map(([id, series]) => [id, valueAt(series, stamp)]));
  $('time-label').textContent = new Date(stamp).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); draw(); renderRoomValues();
}
function stopPlay() { clearInterval(playing); playing = null; $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play history'); }

$('setup-toggle').onclick = () => setSetup(!setup);
$('live-button').onclick = () => { setMode('live'); run(refreshLive)(); };
$('history-button').onclick = run(async () => { setMode('history'); await loadHistory(); });
for (const t of ['room', 'door', 'select']) $(`${t}-tool`).onclick = () => setTool(t);
$('undo-point').onclick = () => { draft.pop(); draw(); };
function finishRoom() {
  if (draft.length < 3 || !$('room-name').value.trim()) { notice('Give the room a name and draw at least three corners.'); return; }
  floor().rooms.push({ id: id(), name: $('room-name').value.trim(), polygon: [...draft] }); draft = []; $('room-name').value = ''; notice(); markDirty();
}
$('finish-room').onclick = finishRoom;
document.addEventListener('keydown', e => { if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return; if (e.key === 'Escape') setTool('select'); if (setup && tool === 'room' && e.key === 'Backspace') { e.preventDefault(); draft.pop(); draw(); } });
$('floor-name').oninput = () => { if (floor()) { floor().name = $('floor-name').value; markDirty(false); } };
$('ha-floor').onchange = () => { floor().ha_floor_id = $('ha-floor').value; markDirty(false); };
$('sensor-search').oninput = renderSensors; $('show-ignored').onchange = renderSensors; $('refresh-sensors').onclick = run(loadCatalog);
$('save').onclick = run(async () => {
  if (demo) return;
  busy = true; const savedChanges = changes; renderSidebar();
  try { const saved = await api('api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }); layout.revision = saved.revision; dirty = changes !== savedChanges; $('save-state').textContent = dirty ? 'Unsaved changes' : 'All changes saved'; notice(); }
  finally { busy = false; renderSidebar(); }
});
$('delete-floor').onclick = run(async () => { if (!confirm(`Delete ${floor().name} and its setup? The image file will remain on disk.`)) return; layout.floors = layout.floors.filter(f => f.id !== floorID); dirty = true; await selectFloor(layout.floors[0]?.id || ''); markDirty(false); });
function openFloorDialog() { if (demo) { notice('Exit the demo before adding your own floor plans.'); return; } floorOptions($('new-ha-floor')); $('floor-dialog').showModal(); }
for (const name of ['add-floor', 'empty-add']) $(name).onclick = openFloorDialog;
$('cancel-floor').onclick = () => $('floor-dialog').close();
$('floor-form').onsubmit = run(async e => {
  e.preventDefault(); const form = e.target, submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { const data = new FormData(form), upload = await api('api/images', { method: 'POST', body: data });
    const f = { id: id(), name: data.get('name').trim(), ha_floor_id: data.get('ha_floor_id'), image: upload.image, rooms: [], sensors: [], doors: [] };
    layout.floors.push(f); dirty = true; $('floor-dialog').close(); form.reset(); setSetup(true); await selectFloor(f.id); markDirty(false);
  } finally { submit.disabled = false; }
});
for (const name of ['opacity', 'scale-min', 'scale-max']) $(name).oninput = () => { if (Number($('scale-max').value) <= Number($('scale-min').value)) return; draw(); };
$('zoom-in').onclick = () => { zoom = Math.min(4, zoom + .25); resize(); }; $('zoom-out').onclick = () => { zoom = Math.max(.5, zoom - .25); resize(); }; $('zoom-fit').onclick = () => { zoom = 1; resize(); };
new ResizeObserver(resize).observe($('viewport'));
$('load-history').onclick = run(loadHistory); $('range').onchange = run(loadHistory); $('history-detail').onchange = run(loadHistory); $('scrub').oninput = scrub;
$('play').onclick = () => { if (playing) { stopPlay(); return; } if (!history) return; if (Number($('scrub').value) >= 1000) $('scrub').value = 0; $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause history'); playing = setInterval(() => { $('scrub').value = Math.min(1000, Number($('scrub').value) + 5); scrub(); if (Number($('scrub').value) >= 1000) stopPlay(); }, 100); };
const now = new Date(); $('history-end').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
window.addEventListener('beforeunload', e => { if (dirty && !demo) { e.preventDefault(); e.returnValue = ''; } });

function demoImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="680" viewBox="0 0 1000 680"><rect width="1000" height="680" fill="#fbfaf5"/><g fill="none" stroke="#dddccc" stroke-width="1">${Array.from({ length: 28 }, (_, i) => `<path d="M50 ${50 + i * 21}H950"/>`).join('')}</g><g fill="none" stroke="#666b5b" stroke-width="10" stroke-linejoin="miter"><path d="M50 50H950V630H50Z M500 50V285 M500 345V630 M50 380H210 M275 380H500 M500 380H705 M770 380H950"/></g><g stroke="#b4b6a3" fill="#eeeee4" stroke-width="2"><rect x="95" y="105" width="200" height="78" rx="10"/><rect x="95" y="185" width="70" height="125" rx="10"/><rect x="225" y="227" width="95" height="65" rx="25"/><rect x="720" y="92" width="180" height="55" rx="5"/><rect x="845" y="147" width="55" height="140" rx="5"/><rect x="650" y="225" width="100" height="85" rx="6"/><rect x="100" y="440" width="155" height="135" rx="6"/><rect x="109" y="448" width="60" height="36" rx="6"/><rect x="185" y="448" width="60" height="36" rx="6"/><rect x="760" y="460" width="130" height="65" rx="6"/></g><g fill="none" stroke="#90a687" stroke-width="4"><path d="M130 50H290 M650 50H820 M50 470V565 M950 460V565"/></g><g fill="#ccd7bf"><circle cx="420" cy="115" r="24"/><circle cx="565" cy="550" r="21"/></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function demoValues(stamp) { const t = stamp / 3600000; const values = { 'sensor.lounge_window': 19.4 + Math.sin(t / 4) * 1.8, 'sensor.lounge_sofa': 23.6 + Math.sin(t / 4 + 1) * 1.4, 'sensor.kitchen': 24.5 + Math.sin(t / 3) * 1.6, 'sensor.bedroom': 18.4 + Math.sin(t / 5) * 1.2 };
  for (const [id, value] of Object.entries(values)) {
    values[id + '_humidity'] = 45 + (value - 20) * 2;
    values[id + '_rssi'] = -75 + (value - 20) * 5;
    values[id + '_lqi'] = 120 + (value - 20) * 10;
  }
  return values;
}
function demoHistory(start, end, days) {
  const hourly = days > 1 || $('history-detail').value === 'hour', step = hourly ? 3600000 : 300000, series = {};
  for (let t = start.getTime(); t < end.getTime(); t += step) for (const [id, value] of Object.entries(demoValues(t))) (series[id] ||= []).push({ start: t, end: Math.min(t + step, end.getTime()), value });
  return { start: start.getTime(), end: end.getTime(), resolution: hourly ? 'hour' : 'states', series, warnings: [] };
}
async function toggleDemo() {
  if (demo) { demo = false; dirty = false; $('demo').textContent = 'Try demo'; await initialize(); return; }
  if (dirty && !confirm('Discard unsaved setup changes and enter the demo?')) return;
  sourceEpoch++; demo = true; dirty = false; configured = false; $('demo').textContent = 'Exit demo';
  const poly = (x1, y1, x2, y2) => [{ x: x1 / 1000, y: y1 / 680 }, { x: x2 / 1000, y: y1 / 680 }, { x: x2 / 1000, y: y2 / 680 }, { x: x1 / 1000, y: y2 / 680 }];
  layout = { version: 1, revision: 0, ignored: [], floors: [{ id: 'demo', name: 'Ground floor', ha_floor_id: 'ground', image: '', rooms: [
    { id: 'lounge', name: 'Living room', polygon: poly(55, 55, 495, 375) }, { id: 'kitchen', name: 'Kitchen', polygon: poly(505, 55, 945, 375) }, { id: 'bedroom', name: 'Bedroom', polygon: poly(55, 385, 495, 625) }, { id: 'study', name: 'Study', polygon: poly(505, 385, 945, 625) }], sensors: [
    { entity_id: 'sensor.lounge_window', room_id: 'lounge', point: { x: .15, y: .17 } }, { entity_id: 'sensor.lounge_sofa', room_id: 'lounge', point: { x: .42, y: .46 } }, { entity_id: 'sensor.kitchen', room_id: 'kitchen', point: { x: .82, y: .28 } }, { entity_id: 'sensor.bedroom', room_id: 'bedroom', point: { x: .19, y: .79 } }], doors: [
    { id: 'd1', room_a: 'lounge', room_b: 'kitchen', a: { x: .48, y: .46 }, b: { x: .52, y: .46 }, influence: .35 }, { id: 'd2', room_a: 'lounge', room_b: 'bedroom', a: { x: .24, y: .54 }, b: { x: .24, y: .59 }, influence: .35 }, { id: 'd3', room_a: 'kitchen', room_b: 'study', a: { x: .735, y: .54 }, b: { x: .735, y: .59 }, influence: .35 }] }] };
  for (const p of [...layout.floors[0].sensors]) for (const m of ['humidity', 'rssi', 'lqi']) layout.floors[0].sensors.push({ ...p, entity_id: p.entity_id + '_' + m, metric: m });
  layout.floors[0].references = [{ id: 'ap', name: 'Hall AP', kind: 'wifi', point: { x: .5, y: .5 } }];
  catalog = { floors: [{ floor_id: 'ground', name: 'Ground floor' }], sensors: Object.keys(demoValues(Date.now())).map(entity_id => ({ entity_id, name: entity_id.slice(7).replaceAll('_', ' '), metric: ['humidity', 'rssi', 'lqi'].find(m => entity_id.endsWith('_' + m)) || 'temperature', floor_id: 'ground' })) };
  image = null; field = null; cells = [];
  setMode('live'); setSetup(false); await refreshLive(); await selectFloor('demo'); notice('Demo with simulated temperatures. The study has no sensor: its temperature is estimated through the kitchen doorway.');
}
$('demo').onclick = run(toggleDemo); $('empty-demo').onclick = run(toggleDemo);
async function initialize() {
  sourceEpoch++;
  stopPlay(); historyRequest++; imageRequest++; history = null; currentValues = {}; liveValues = {}; image = null; field = null; cells = [];
  const [status, saved] = await Promise.all([api('api/status'), api('api/layout')]); layout = saved; configured = status.configured; catalog = { sensors: [], floors: [] };
  $('connection').textContent = configured ? 'Connecting to HA…' : 'HA not connected';
  setMode('live'); setSetup(false); await selectFloor(findFloor(layout.floors, params.get('floor'))?.id || layout.floors[0]?.id || '');
  notice(configured ? '' : 'Ready for your floor plans. To connect Home Assistant, set HA_URL and HA_TOKEN on the server and restart. You can also try the demo.');
  await loadCatalog();
}
startTheme(() => {
  const style = getComputedStyle(document.documentElement);
  labelTheme = { background: style.getPropertyValue('--surface').trim(), text: style.getPropertyValue('--text').trim() };
  draw();
});
configureMetric();
run(initialize)();
setInterval(async () => {
  if (document.hidden || (!configured && !demo)) return;
  try { await refreshLive(); }
  catch (e) { $('connection').textContent = 'HA disconnected'; if (Date.now() - lastLive > 60000) { liveValues = {}; if (mode === 'live') { currentValues = {}; draw(); renderRoomValues(); } } notice(e.message); }
}, 15000);

function configureMetric() {
  const spec = metrics[metric];
  options($('metric'), allowedMetrics.map(m => [m, metrics[m].name]), metric);
  $('metric').hidden = allowedMetrics.length === 1;
  $('metric-title').textContent = spec.name; $('metric-unit').textContent = ' ' + spec.unit;
  for (const edge of ['min', 'max']) {
    const input = $('scale-' + edge); input.removeAttribute('min'); input.removeAttribute('max'); input.value = spec[edge];
    input.setAttribute('aria-label', edge + ' colour scale');
  }
  $('network-control').hidden = !signal(); $('reference-controls').hidden = !signal();
  $('pair-humidity').title = 'Find unique matches on the same HA device or with the same entity-name prefix, across all floors';
  $('pair-humidity').hidden = metric !== 'humidity'; $('pair-summary').hidden = metric !== 'humidity';
  $('view-panel').querySelector('.hint').textContent = signal()
    ? 'Signal is interpolated across the floor from reported device readings. This is not a radio propagation survey; AP and coordinator markers are references only.'
    : 'Room averages marked * are estimated through doorways without a local reading.';
  $('sensor-search').setAttribute('aria-label', 'Find a sensor or device');
  if (embedded) {
    document.body.classList.add('embedded');
    document.body.classList.toggle('minimal', minimal);
    $('embed-floor').hidden = !!params.get('floor');
    $('history-button').hidden = params.get('history') !== '1';
  }
}
$('metric').onchange = run(async () => {
  metric = $('metric').value; setTool('select'); stopPlay(); historyRequest++; configureMetric(); rebuild(); renderSidebar(); setMode(mode);
  if (mode === 'history') await loadHistory();
});
$('network').onchange = () => { rebuild(); renderSensors(); };
$('device-filter').onchange = renderSensors;
$('embed-floor').onchange = run(() => selectFloor($('embed-floor').value));
$('pair-humidity').onclick = () => {
  const pairs = humidityPairs(layout, catalog.sensors);
  for (const { floor: f, source, sensor } of pairs) f.sensors.push({ entity_id: sensor.entity_id, metric: 'humidity', room_id: source.room_id, point: { ...source.point } });
  $('pair-summary').textContent = pairs.length ? `Paired ${pairs.length} humidity sensors at their temperature sensor locations. Review and Save setup.` : 'No unambiguous matches found. Place humidity sensors manually from the list.';
  if (pairs.length) markDirty();
};
$('add-reference').onclick = () => { movingReference = ''; setTool('reference'); };
function placeSensor(entityID, point) {
  if (!setup || embedded || !floor() || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
  const sensor = catalog.sensors.find(s => s.entity_id === entityID) || floor().sensors.find(s => s.entity_id === entityID);
  if (!sensor || metricOf(sensor) !== metric || layout.ignored.includes(entityID)) return;
  if (layout.floors.some(f => f.id !== floorID && f.sensors.some(s => s.entity_id === entityID))) { notice('Remove this device from its other floor first.'); return; }
  const room = floor().rooms.find(r => inside(point, r.polygon));
  if (!signal() && !room) { notice('Place the sensor inside a room polygon.'); return; }
  const previous = floor().sensors.find(s => s.entity_id === entityID);
  floor().sensors = floor().sensors.filter(s => s.entity_id !== entityID);
  floor().sensors.push({ entity_id: entityID, metric, network: previous?.network || '', room_id: room?.id || '', point });
  setTool('select'); notice(); markDirty();
}
function eventPoint(e) {
  const rect = canvas.getBoundingClientRect(); return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
};
canvas.ondragover = e => { if (setup) e.preventDefault(); };
canvas.ondrop = e => { e.preventDefault(); placeSensor(e.dataTransfer.getData('text/plain'), eventPoint(e)); };
let drag = null, suppressClick = false;
canvas.addEventListener('pointerdown', e => {
  if (!setup || tool !== 'select' || e.button !== 0) return;
  const p = eventPoint(e), rect = canvas.getBoundingClientRect();
  const sensor = activeSensors().find(s => Math.hypot((p.x - s.point.x) * rect.width, (p.y - s.point.y) * rect.height) < 12);
  if (sensor) { drag = { id: sensor.entity_id, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }
});
canvas.addEventListener('pointerup', e => {
  if (!drag) return;
  const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4;
  if (moved) { suppressClick = true; placeSensor(drag.id, eventPoint(e)); }
  drag = null;
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.stopImmediatePropagation(); } }, true);
function hitSensor(e) {
  const p = eventPoint(e), rect = canvas.getBoundingClientRect();
  return activeSensors().find(s => Math.hypot((p.x - s.point.x) * rect.width, (p.y - s.point.y) * rect.height) < 10);
}
canvas.addEventListener('pointermove', e => {
  if (minimal) return;
  if (!floor()) return;
  const p = eventPoint(e), rect = canvas.getBoundingClientRect();
  const sensor = activeSensors().find(s => Math.hypot((p.x - s.point.x) * rect.width, (p.y - s.point.y) * rect.height) < 10);
  const next = sensor?.entity_id || '';
  canvas.title = sensor ? `${catalog.sensors.find(s => s.entity_id === next)?.name || next}\n${next}\n${format(currentValues[next])}` : '';
  if (hovered !== next) { hovered = next; draw(); }
});
canvas.addEventListener('pointerleave', () => { hovered = ''; draw(); });

$('import-setup').onclick = run(async () => {
  if (embedded || demo || busy) return;
  const file = $('import-file').files[0];
  if (!file) { notice('Choose your transfer ZIP first.'); return; }
  if (file.size > 100 * 1024 * 1024) { notice('Transfer ZIP must be no larger than 100 MB.'); return; }
  if ((layout.floors.length || dirty) && !confirm('Replace this app’s setup with the ZIP contents? Unsaved edits will be discarded. The previous saved layout will be backed up on the server.')) return;
  busy = true; renderSidebar(); document.querySelector('main').inert = true;
  notice('Importing your floor plans and setup…');
  try {
    await api('api/import?' + new URLSearchParams({ revision: layout.revision }), { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    dirty = false; location.reload();
  } finally { busy = false; document.querySelector('main').inert = false; renderSidebar(); }
});
