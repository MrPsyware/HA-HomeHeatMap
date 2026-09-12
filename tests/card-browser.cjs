const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const prefix = '/api/hassio_ingress/test-app/';
    const sensors = [{ entity_id: 'sensor.test_temperature', metric: 'temperature', name: 'Test', value: 21 }];
    await page.route('https://ha.example/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
      assert.ok(pathname.startsWith(prefix), 'card must never load /app/ or HA page shell');
      assert.match(route.request().headers().cookie || '', /ingress_session=test-session/);
      const file = pathname.slice(prefix.length) || 'index.html';
      if (file === 'api/status') return route.fulfill({ json: { configured: true } });
      if (file === 'api/catalog') return route.fulfill({ json: { sensors, floors: [], warnings: [] } });
      if (file === 'api/live') return route.fulfill({ json: sensors });
      if (file === 'api/layout') return route.fulfill({ json: { version: 1, revision: 0, ignored: [], floors: [{
        id: 'upstairs', name: 'Upstairs', image: 'fixture.svg', ha_floor_id: '', doors: [],
        sensors: [{ entity_id: 'sensor.test_temperature', room_id: 'room', point: { x: .5, y: .5 } }],
        rooms: [{ id: 'room', name: 'Landing', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }],
      }] } });
      if (file === 'fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="white"/></svg>' });
      assert.match(file, /^[a-zA-Z0-9.-]+$/);
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
      return route.fulfill({ contentType: types[path.extname(file)], body: readFileSync(path.join(__dirname, '../web', file)) });
    });
    await page.goto('https://ha.example/dashboard');
    await page.addScriptTag({ path: path.join(__dirname, '../web/home-heat-map-card.js') });
    await page.evaluate(() => {
      const card = document.createElement('home-heat-map-card');
      card.setConfig({ url: 'https://ha.example/app/test_home_heat_map', minimal: true, metrics: ['temperature'], floor: 'upstairs', height: 500 });
      document.body.append(card);
      card.hass = { async callWS(req) {
        if (req.endpoint === '/ingress/session') return { session: 'test-session' };
        if (req.endpoint === '/ingress/validate_session') return {};
        return { state: 'started', ingress_url: '/api/hassio_ingress/test-app' };
      } };
    });
    const frame = page.frameLocator('home-heat-map-card iframe');
    await frame.locator('body.minimal').waitFor();
    await frame.locator('#map').waitFor({ state: 'visible' });
    await frame.locator('#connection').filter({ hasText: 'Connected' }).waitFor({ state: 'attached' });
    assert.equal(await frame.locator('.map-toolbar').isVisible(), false);
    assert.equal(await frame.locator('header').isVisible(), false);
    assert.equal(await frame.locator('#timeline').isVisible(), false);
    const src = await page.locator('home-heat-map-card iframe').getAttribute('src');
    assert.equal(new URL(src).searchParams.get('minimal'), '1');
    const cookies = await page.context().cookies('https://ha.example' + prefix);
    assert.ok(cookies.some(c => c.name === 'ingress_session' && c.secure && c.path === '/api/hassio_ingress/'));
    assert.deepEqual(errors, []);
    const mapFrame = page.frames().find(f => f.url().includes(prefix));
    await mapFrame.waitForFunction(() => getComputedStyle(document.querySelector('#viewport')).backgroundColor === 'rgb(17, 19, 21)');
    // HA custom colours cross the iframe boundary and update without navigation.
    await page.evaluate(() => {
      const card = document.querySelector('home-heat-map-card');
      card.style.setProperty('--primary-background-color', '#182838');
      card.style.setProperty('--card-background-color', '#243444');
      card.style.setProperty('--primary-text-color', '#f0f1f2');
      card.hass = { ...card._hass, themes: { darkMode: true } };
    });
    await mapFrame.waitForFunction(() => getComputedStyle(document.querySelector('#viewport')).backgroundColor === 'rgb(24, 40, 56)');
    assert.equal(await mapFrame.evaluate(() => getComputedStyle(document.body).color), 'rgb(240, 241, 242)');
    assert.equal(await page.locator('home-heat-map-card iframe').getAttribute('src'), src);
    await page.evaluate(() => {
      const card = document.querySelector('home-heat-map-card');
      card.style.setProperty('--primary-background-color', '#fafafa');
      card.style.setProperty('--card-background-color', '#ffffff');
      card.style.setProperty('--primary-text-color', '#222222');
      card.hass = { ...card._hass, themes: { darkMode: false } };
    });
    await mapFrame.waitForFunction(() => document.documentElement.dataset.theme === 'light' && getComputedStyle(document.querySelector('#viewport')).backgroundColor === 'rgb(250, 250, 250)');
    // A forced dark theme ignores HA's light colours.
    await page.evaluate(() => { const card = document.querySelector('home-heat-map-card'); card.config.theme = 'dark'; card._sendTheme(); });
    await mapFrame.waitForFunction(() => getComputedStyle(document.querySelector('#viewport')).backgroundColor === 'rgb(17, 19, 21)');
    await mapFrame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin: 'https://untrusted.example', data: { type: 'home-heat-map-theme', theme: { mode: 'light', background: 'red' } } })));
    assert.equal(await mapFrame.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(errors, []);
    console.log('PASS: card establishes ingress cookie and directly loads the real minimal-map UI through mocked HA ingress.');
    console.log('PASS: dark default, HA custom colours, live light/dark switching, explicit dark override and message origin checks.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
