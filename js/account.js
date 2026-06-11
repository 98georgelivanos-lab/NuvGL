// Optional account sync — Supabase-backed addon list, so the same set of
// addons can be shared across devices/apps pointed at the same project
// (e.g. a future NuvioTV build using the same schema, see supabase/schema.sql).
const Account = {
  client: null,
  _url: null,
  _key: null,

  isConfigured() {
    const s = Store.getSettings();
    return !!(s.supabaseUrl && s.supabaseAnonKey);
  },

  client_() {
    const s = Store.getSettings();
    if (!s.supabaseUrl || !s.supabaseAnonKey) {
      this.client = null;
      return null;
    }
    if (!this.client || this._url !== s.supabaseUrl || this._key !== s.supabaseAnonKey) {
      this.client = window.supabase.createClient(s.supabaseUrl, s.supabaseAnonKey);
      this._url = s.supabaseUrl;
      this._key = s.supabaseAnonKey;
    }
    return this.client;
  },

  reset() {
    this.client = null;
    this._url = null;
    this._key = null;
  },

  async getSession() {
    const client = this.client_();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session || null;
  },

  async signUp(email, password) {
    const client = this.client_();
    if (!client) throw new Error('Configure Supabase first');
    const { error } = await client.auth.signUp({ email, password });
    if (error) throw error;
  },

  async signIn(email, password) {
    const client = this.client_();
    if (!client) throw new Error('Configure Supabase first');
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async signOut() {
    const client = this.client_();
    if (!client) return;
    await client.auth.signOut();
  },

  // ---------------- Addon sync ----------------
  async pushAddons() {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const addons = Addons.list().map((a, idx) => ({
      url: a.manifestUrl,
      sort_order: idx,
      enabled: true,
      name: (a.manifest && a.manifest.name) || null,
    }));
    const { error } = await client.rpc('sync_push_addons', { p_addons: addons, p_profile_id: 1 });
    if (error) throw error;
  },

  async pullAddons() {
    const client = this.client_();
    if (!client) return [];
    const session = await this.getSession();
    if (!session) return [];
    const { data, error } = await client
      .from('addons')
      .select('url,sort_order,enabled,name')
      .eq('profile_id', 1)
      .order('sort_order');
    if (error) throw error;
    return data || [];
  },

  // Pull addons that exist remotely but not locally, install them, then push
  // the merged list back so both sides end up in sync. Returns the number of
  // addons newly added locally.
  async syncAddons() {
    const remote = await this.pullAddons();
    let added = 0;
    for (const r of remote) {
      if (Addons.list().some((a) => a.manifestUrl === r.url)) continue;
      try {
        await Addons.add(r.url);
        added++;
      } catch (e) {
        console.warn('Account sync: failed to add remote addon', r.url, e);
      }
    }
    await this.pushAddons();
    return added;
  },
};
