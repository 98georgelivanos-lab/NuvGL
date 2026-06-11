// Thin fetch wrapper with optional CORS proxy support (configurable in Settings).
const Api = {
  async fetchJson(url) {
    const settings = Store.getSettings();
    const target = settings.corsProxy
      ? settings.corsProxy.replace(/\/$/, '') + '/' + url
      : url;
    const res = await fetch(target, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  },
};
