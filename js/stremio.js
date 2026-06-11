// Stremio addon HTTP protocol: catalog / meta / stream lookups.
const Stremio = {
  buildExtraPath(extra) {
    const parts = Object.entries(extra || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    return parts.length ? `/${parts.join('&')}` : '';
  },

  async getCatalog(addon, type, catalogId, extra) {
    const path = `${addon.baseUrl}/catalog/${type}/${catalogId}${this.buildExtraPath(extra)}.json`;
    const data = await Api.fetchJson(path);
    return data.metas || [];
  },

  async search(query, type) {
    const results = [];
    const addons = Addons.list();
    await Promise.all(
      addons.map(async (addon) => {
        const catalogs = (addon.manifest.catalogs || []).filter(
          (c) => (!type || c.type === type) && Addons.catalogSupportsSearch(addon, c)
        );
        for (const catalog of catalogs) {
          try {
            const metas = await this.getCatalog(addon, catalog.type, catalog.id, { search: query });
            metas.forEach((m) => results.push({ ...m, _addon: addon.manifest.name }));
          } catch (e) {
            console.warn('search failed', addon.manifest.name, catalog.id, e);
          }
        }
      })
    );
    // de-dupe by id, keep first
    const seen = new Set();
    return results.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  },

  async getMeta(type, id) {
    const addons = Addons.metaAddons(type);
    for (const addon of addons) {
      try {
        const data = await Api.fetchJson(`${addon.baseUrl}/meta/${type}/${id}.json`);
        if (data && data.meta) return data.meta;
      } catch (e) {
        console.warn('meta failed', addon.manifest.name, e);
      }
    }
    return null;
  },

  async getStreams(type, id) {
    const addons = Addons.streamAddons(type);
    const out = [];
    await Promise.all(
      addons.map(async (addon) => {
        try {
          const data = await Api.fetchJson(`${addon.baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`);
          (data.streams || []).forEach((s) => out.push({ ...s, _addon: addon.manifest.name }));
        } catch (e) {
          console.warn('streams failed', addon.manifest.name, e);
        }
      })
    );
    return out;
  },
};
