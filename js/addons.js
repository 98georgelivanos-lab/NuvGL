// Stremio addon manifest management.
const Addons = {
  _cache: null,

  list() {
    if (!this._cache) this._cache = Store.getAddons();
    return this._cache;
  },

  save() {
    Store.saveAddons(this._cache || []);
  },

  baseUrlFromManifest(manifestUrl) {
    return manifestUrl.replace(/\/manifest\.json.*$/, '');
  },

  async fetchManifest(manifestUrl) {
    const data = await Api.fetchJson(manifestUrl);
    if (!data || !data.id || !data.name) {
      throw new Error('Not a valid Stremio addon manifest');
    }
    return data;
  },

  async add(manifestUrl) {
    manifestUrl = manifestUrl.trim();
    if (!manifestUrl) throw new Error('Enter a manifest URL');
    if (!/manifest\.json/.test(manifestUrl)) {
      manifestUrl = manifestUrl.replace(/\/?$/, '/manifest.json');
    }
    const manifest = await this.fetchManifest(manifestUrl);
    const list = this.list();
    if (list.some((a) => a.manifestUrl === manifestUrl)) {
      throw new Error('Addon already added');
    }
    const entry = {
      manifestUrl,
      baseUrl: this.baseUrlFromManifest(manifestUrl),
      manifest,
    };
    list.push(entry);
    this.save();
    return entry;
  },

  remove(manifestUrl) {
    this._cache = this.list().filter((a) => a.manifestUrl !== manifestUrl);
    this.save();
  },

  async ensureDefaults() {
    if (this.list().length > 0) return;
    for (const url of DEFAULT_ADDONS) {
      try {
        await this.add(url);
      } catch (e) {
        console.warn('Failed to install default addon', url, e);
      }
    }
  },

  resourceList(addon, resourceName) {
    const res = addon.manifest.resources || [];
    return res
      .map((r) => (typeof r === 'string' ? { name: r, types: addon.manifest.types || [], idPrefixes: null } : r))
      .filter((r) => r.name === resourceName);
  },

  supports(addon, resourceName, type) {
    return this.resourceList(addon, resourceName).some(
      (r) => !r.types || r.types.includes(type)
    );
  },

  catalogAddons(type) {
    return this.list().filter((a) => this.supports(a, 'catalog', type));
  },

  streamAddons(type) {
    return this.list().filter((a) => this.supports(a, 'stream', type));
  },

  metaAddons(type) {
    return this.list().filter((a) => this.supports(a, 'meta', type));
  },

  catalogsFor(addon, type) {
    return (addon.manifest.catalogs || []).filter((c) => c.type === type);
  },

  catalogSupportsSearch(addon, catalog) {
    return (catalog.extra || []).some((e) => e.name === 'search');
  },
};
