const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../web/home-heat-map-card.js'), 'utf8');

function fixture() {
  class Element {
    constructor() { this.isConnected = true; this.children = []; this.style = {}; }
    attachShadow() { return this.shadowRoot = new Element(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
  }
  const registered = new Map(), timers = new Map(); let timerID = 0;
  const document = { cookie: '', hidden: false, createElement: () => new Element() };
  runInNewContext(source, {
    HTMLElement: Element, URL, location: new URL('https://ha.example/dashboard'), document, window: {},
    customElements: { get: name => registered.get(name), define: (name, ctor) => registered.set(name, ctor) },
    setInterval: fn => { timers.set(++timerID, fn); return timerID; }, clearInterval: id => timers.delete(id),
  });
  const Card = registered.get('home-heat-map-card');
  const calls = [];
  const hass = { async callWS(request) {
    calls.push(request);
    if (request.endpoint === '/ingress/session') return { session: 'session-test' };
    if (request.endpoint === '/ingress/validate_session') return {};
    return { state: 'started', ingress_url: '/api/hassio_ingress/app-token' };
  } };
  return { Card, document, hass, calls, timers };
}
async function settled(card) {
  for (let i = 0; i < 30 && card._loading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._loading, false);
}
test('HA panel URLs resolve to direct ingress with map options and scoped cookie', async () => {
  const { Card, document, hass, calls } = fixture(); const card = new Card();
  card.setConfig({ url: 'https://ha.example/app/test_home_heat_map', minimal: true, metrics: ['humidity'], floor: 'Upstairs' });
  assert.equal(card._frame.src, undefined);
  card.hass = hass; await settled(card);
  const url = new URL(card._frame.src);
  assert.equal(url.pathname, '/api/hassio_ingress/app-token/');
  assert.equal(url.searchParams.get('minimal'), '1');
  assert.equal(url.searchParams.get('floor'), 'Upstairs');
  assert.equal(url.searchParams.get('metrics'), 'humidity');
  assert.match(document.cookie, /path=\/api\/hassio_ingress\/;SameSite=Strict;Secure$/);
  assert.ok(calls.some(c => c.endpoint === '/addons/test_home_heat_map/info'));
  const before = calls.length;
  card.hass = hass; await settled(card); assert.equal(calls.length, before);
});
test('explicit addon creates session, renews expiry and cleans up timer', async () => {
  const { Card, hass, calls, timers } = fixture(); const card = new Card();
  card.setConfig({ addon: 'test_app', minimal: 1 }); card.hass = hass; await settled(card);
  const callWS = hass.callWS;
  hass.callWS = async req => { if (req.endpoint === '/ingress/validate_session') throw Error('expired'); return callWS(req); };
  await card._loadIngress();
  assert.equal(calls.filter(c => c.endpoint === '/ingress/session').length, 2);
  assert.equal(card._error, false);
  assert.equal(timers.size, 1); card.disconnectedCallback(); assert.equal(timers.size, 0);
});
test('stopped app and permission errors show retry instead of the HA interface', async () => {
  const { Card } = fixture(); const card = new Card();
  card.setConfig({ addon: 'test_app' });
  card.hass = { async callWS() { throw Error('Forbidden'); } }; await settled(card);
  assert.match(card._status.textContent, /Forbidden/); assert.equal(card._retry.hidden, false);
  assert.equal(card._frame.src, undefined);
  card._hass = { async callWS(req) { return req.endpoint === '/ingress/session' ? { session: 'session-test' } : { state: 'stopped' }; } };
  await card._loadIngress(); assert.match(card._status.textContent, /Start Home Heat Map/);
});
test('an old ingress response cannot override newer standalone configuration', async () => {
  const { Card, hass } = fixture(); const card = new Card(); let release;
  const original = hass.callWS;
  hass.callWS = req => req.endpoint.endsWith('/info') ? new Promise(resolve => { release = resolve; }) : original(req);
  card.setConfig({ addon: 'test_app' }); card.hass = hass;
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  card.setConfig({ url: 'https://maps.example/', minimal: true });
  release({ state: 'started', ingress_url: '/api/hassio_ingress/old-token' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new URL(card._frame.src).origin, 'https://maps.example');
});
test('rejects cross-origin ingress targets and preserves standalone URLs', async () => {
  const { Card, hass } = fixture(); const card = new Card();
  assert.throws(() => card.setConfig({ url: 'https://other.example/app/test_app' }), /HA instance/);
  card.setConfig({ addon: 'test_app' });
  const original = hass.callWS;
  hass.callWS = req => req.endpoint.endsWith('/info') ? Promise.resolve({ state: 'started', ingress_url: 'https://other.example/api/hassio_ingress/token' }) : original(req);
  card.hass = hass; await settled(card);
  assert.equal(card._frame.src, undefined); assert.match(card._status.textContent, /unexpected ingress URL/);
  card.setConfig({ url: 'https://maps.example/prefix/', minimal: true });
  assert.equal(new URL(card._frame.src).pathname, '/prefix/');
  assert.equal(new URL(card._frame.src).searchParams.get('minimal'), '1');
});
