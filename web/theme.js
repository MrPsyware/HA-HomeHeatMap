// Only accept colour values from the embedding card, never arbitrary CSS.
export function startTheme(onChange) {
  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  const variables = { background: '--page', surface: '--surface', text: '--text', muted: '--muted', border: '--line', accent: '--green' };
  function apply(theme) {
    root.dataset.theme = theme.mode === 'light' ? 'light' : 'dark';
    for (const [key, variable] of Object.entries(variables)) {
      const value = theme[key];
      if (typeof value === 'string' && value.length <= 128 && CSS.supports('color', value)) root.style.setProperty(variable, value);
      else root.style.removeProperty(variable);
    }
    onChange();
  }
  apply({ mode: params.get('theme') });
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== params.get('theme_origin')) return;
    if (event.data?.type === 'home-heat-map-theme' && ['dark', 'light'].includes(event.data.theme?.mode)) apply(event.data.theme);
  });
}
