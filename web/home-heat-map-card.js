/* Copy this file to HA /config/www/ and register it as a JavaScript module. */
class HomeHeatMapCard extends HTMLElement {
  setConfig(config) {
    if (!config.url) throw new Error('Set url to your Home Heat Map app base URL.');
    const url = new URL(config.url, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials.');
    const layers = config.metrics || ['temperature', 'humidity'];
    if (!Array.isArray(layers) || !layers.length || layers.some(m => !['temperature', 'humidity', 'rssi', 'lqi'].includes(m))) throw new Error('metrics must contain temperature, humidity, rssi or lqi.');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.searchParams.set('embed', '1');
    url.searchParams.set('minimal', config.minimal === true ? '1' : '0');
    url.searchParams.set('device_labels', config.device_labels === true ? '1' : '0');
    url.searchParams.set('metrics', layers.join(','));
    url.searchParams.set('history', config.history === true ? '1' : '0');
    if (config.floor) url.searchParams.set('floor', config.floor);
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const card = document.createElement('ha-card'), frame = document.createElement('iframe');
    frame.src = url.href; frame.title = config.title || 'Home Heat Map';
    frame.style.cssText = 'width:100%;border:0;display:block;';
    frame.style.height = Math.max(250, Math.min(1600, Number(config.height) || 550)) + 'px';
    frame.setAttribute('loading', 'lazy');
    card.append(frame); root.replaceChildren(card);
    this.config = config;
  }
  set hass(value) { /* Readings are fetched by the app server; HA tokens never enter the iframe. */ }
  getCardSize() { return Math.ceil((Number(this.config?.height) || 550) / 50); }
  getGridOptions() { return { columns: 12, rows: 8, min_columns: 6, min_rows: 4 }; }
}
if (!customElements.get('home-heat-map-card')) customElements.define('home-heat-map-card', HomeHeatMapCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'home-heat-map-card', name: 'Home Heat Map', description: 'Floor plans with temperature, humidity and signal layers.' });
