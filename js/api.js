// Thin fetch wrapper with optional CORS proxy support (configurable in Settings).
const Api = {
  // Query-style proxies (e.g. https://corsproxy.io/?url= or a trailing "?")
  // need the target URL encoded and appended directly; path-style proxies
  // need it appended as a path segment.
  proxiedUrl(proxy, url) {
    if (/[?=]$/.test(proxy)) return proxy + encodeURIComponent(url);
    return proxy.replace(/\/$/, '') + '/' + url;
  },

  async fetchJson(url) {
    const settings = Store.getSettings();
    const target = settings.corsProxy ? this.proxiedUrl(settings.corsProxy.trim(), url) : url;
    const res = await fetch(target, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  },
};
