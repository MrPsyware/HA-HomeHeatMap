/* Copy this file to HA /config/www/ and register it as a JavaScript module. */
// Use the same authenticated ingress-session flow as the HA frontend.
let ingressSession = '', ingressRequest;
function ensureIngressSession(hass) {
  if (ingressRequest) return ingressRequest;
  ingressRequest = (async () => {
    if (ingressSession) {
      try {
        await hass.callWS({ type: 'supervisor/api', endpoint: '/ingress/validate_session', method: 'post', data: { session: ingressSession } });
      } catch { ingressSession = ''; }
    }
    if (!ingressSession) {
      const result = await hass.callWS({ type: 'supervisor/api', endpoint: '/ingress/session', method: 'post' });
      if (!result.session || !/^[A-Za-z0-9_-]+$/.test(result.session)) throw Error('Home Assistant did not return an ingress session.');
      ingressSession = result.session;
    }
    document.cookie = `ingress_session=${ingressSession};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === 'https:' ? ';Secure' : ''}`;
  })().finally(() => { ingressRequest = undefined; });
  return ingressRequest;
}
class HomeHeatMapCard extends HTMLElement {
  setConfig(config) {
    if (!config.url && !config.addon) throw new Error('Set addon to the installed HA app slug, or url to a standalone app.');
    const url = new URL(config.url || '/', location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials.');
    const panel = url.pathname.match(/^\/(?:app|hassio\/ingress)\/([a-zA-Z0-9_-]+)\/?$/);
    const addon = config.addon || panel?.[1];
    if (addon && (typeof addon !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(addon))) throw Error('addon must be the installed HA app slug.');
    if (panel && !config.addon && url.origin !== location.origin) throw Error('Use addon with the HA instance displaying this dashboard.');
    const layers = config.metrics || ['temperature', 'humidity'];
    if (config.theme && !['auto', 'dark', 'light'].includes(config.theme)) throw Error('theme must be auto, dark or light.');
    if (!Array.isArray(layers) || !layers.length || layers.some(m => !['temperature', 'humidity', 'rssi', 'lqi'].includes(m))) throw new Error('metrics must contain temperature, humidity, rssi or lqi.');
    this._generation = (this._generation || 0) + 1;
    this._loading = false; this._ready = false; this._error = false;
    this.config = { ...config, metrics: [...layers] }; this._addon = addon;
    clearInterval(this._timer);
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const card = document.createElement('ha-card'), frame = document.createElement('iframe');
    frame.title = config.title || 'Home Heat Map';
    frame.style.cssText = 'width:100%;border:0;display:block;';
    frame.style.height = Math.max(250, Math.min(1600, Number(config.height) || 550)) + 'px';
    frame.setAttribute('loading', 'lazy');
    this._frame = frame;
    frame.onload = () => this._sendTheme(true);
    this._status = document.createElement('div'); this._status.setAttribute('role', 'status');
    this._status.style.cssText = 'padding:16px;';
    this._retry = document.createElement('button'); this._retry.textContent = 'Retry connection';
    this._retry.onclick = () => this._loadIngress(); this._retry.hidden = true;
    this._status.textContent = addon ? 'Connecting to Home Heat Map…' : '';
    this._status.hidden = !addon; frame.hidden = !!addon;
    card.append(this._status, this._retry, frame); root.replaceChildren(card);
    if (addon) this._connect();
    else frame.src = this._mapURL(url).href;
    this._watchTheme();
  }
  _mapURL(url) {
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    const config = this.config;
    const enabled = value => value === true || value === 1 || value === '1' || value === 'true';
    url.searchParams.set('embed', '1');
    url.searchParams.set('minimal', enabled(config.minimal) ? '1' : '0');
    url.searchParams.set('device_labels', config.device_labels === true ? '1' : '0');
    url.searchParams.set('metrics', config.metrics.join(','));
    url.searchParams.set('history', config.history === true ? '1' : '0');
    url.searchParams.set('theme', config.theme === 'light' ? 'light' : 'dark');
    url.searchParams.set('theme_origin', location.origin);
    if (config.floor) url.searchParams.set('floor', config.floor);
    return url;
  }
  set hass(value) {
    this._hass = value;
    this._queueTheme();
    if (!this._ready && !this._error) this._loadIngress();
  }
  connectedCallback() { this._connect(); this._watchTheme(); }
  disconnectedCallback() {
    clearInterval(this._timer); this._timer = undefined;
    this._generation = (this._generation || 0) + 1; this._loading = false;
    this._themeObserver?.disconnect();
    if (this._themeFrame) cancelAnimationFrame(this._themeFrame);
    this._themeFrame = undefined;
  }
  _watchTheme() {
    this._themeObserver?.disconnect();
    if (!this.isConnected || typeof MutationObserver === 'undefined') return;
    this._themeObserver = new MutationObserver(() => this._queueTheme());
    for (const target of [this, document.documentElement]) this._themeObserver.observe(target, { attributes: true, attributeFilter: ['style', 'class'] });
    this._queueTheme();
  }
  _queueTheme() {
    if (typeof requestAnimationFrame === 'undefined' || this._themeFrame) return;
    this._themeFrame = requestAnimationFrame(() => { this._themeFrame = undefined; this._sendTheme(); });
  }
  _sendTheme(force = false) {
    if (!this._frame?.src || !this._frame.contentWindow || typeof getComputedStyle === 'undefined') return;
    const style = getComputedStyle(this), selection = this.config.theme || 'auto';
    const theme = { mode: selection === 'auto' ? (this._hass?.themes?.darkMode === false ? 'light' : 'dark') : selection };
    if (selection === 'auto') {
      const colors = { background: '--primary-background-color', surface: '--card-background-color', text: '--primary-text-color', muted: '--secondary-text-color', border: '--divider-color', accent: '--primary-color' };
      for (const [key, variable] of Object.entries(colors)) {
        const value = style.getPropertyValue(variable).trim();
        if (value && CSS.supports('color', value)) theme[key] = value;
      }
    }
    const message = JSON.stringify(theme);
    if (!force && message === this._lastTheme) return;
    this._lastTheme = message;
    this._frame.contentWindow.postMessage({ type: 'home-heat-map-theme', theme }, new URL(this._frame.src).origin);
  }
  _connect() {
    if (!this.isConnected || !this._addon) return;
    clearInterval(this._timer);
    this._timer = setInterval(() => { if (!document.hidden) this._loadIngress(); }, 60000);
    this._loadIngress();
  }
  async _loadIngress() {
    if (!this.isConnected || !this._addon || !this._hass || this._loading) return;
    this._loading = true;
    const generation = this._generation, addon = this._addon, hass = this._hass;
    try {
      await ensureIngressSession(hass);
      const info = await hass.callWS({ type: 'supervisor/api', endpoint: `/addons/${addon}/info`, method: 'get' });
      if (generation !== this._generation) return;
      if (info.state !== 'started') throw Error('Start Home Heat Map in the HA app settings, then retry.');
      if (!info.ingress_url) throw Error('This HA app does not expose an ingress URL.');
      const url = new URL(info.ingress_url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/hassio_ingress/')) throw Error('Home Assistant returned an unexpected ingress URL.');
      const src = this._mapURL(url).href;
      if (this._frame.src !== src || this._error) this._frame.src = src;
      this._frame.hidden = false; this._status.hidden = true; this._retry.hidden = true;
      this._ready = true; this._error = false;
    } catch (error) {
      if (generation !== this._generation) return;
      this._error = true; this._ready = false; this._frame.hidden = true;
      this._status.textContent = `Cannot open Home Heat Map through HA ingress. ${error.message || 'Check your HA user permissions and app slug.'}`;
      this._status.hidden = false; this._retry.hidden = false;
    } finally { if (generation === this._generation) this._loading = false; }
  }
  getCardSize() { return Math.ceil((Number(this.config?.height) || 550) / 50); }
  getGridOptions() { return { columns: 12, rows: 8, min_columns: 6, min_rows: 4 }; }
}
if (!customElements.get('home-heat-map-card')) customElements.define('home-heat-map-card', HomeHeatMapCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'home-heat-map-card', name: 'Home Heat Map', description: 'Floor plans with temperature, humidity and signal layers.' });
