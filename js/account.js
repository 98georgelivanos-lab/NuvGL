// Streamfield account sync — Supabase-backed addons, library, watch progress,
// watched history and profiles, shared with the Streamfield TV app (same
// project and schema, see supabase/schema.sql). Users just sign up with an
// email/password; the project credentials are baked in below.
//
// Plugins are intentionally not synced from this client.
const SUPABASE_URL = 'https://pflmerquxgpehmasqowk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lW_RKcu5WW6NMN8bqLC6Hg_z04Wo0_A';

const Account = {
  client: null,

  isConfigured() {
    // The supabase-js bundle is vendored locally, but guard anyway so a
    // failed script load (or very old cached shell) degrades gracefully.
    return typeof window.supabase !== 'undefined';
  },

  client_() {
    if (!this.isConfigured()) return null;
    if (!this.client) {
      this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return this.client;
  },

  async getSession() {
    const client = this.client_();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session || null;
  },

  async signUp(email, password) {
    const client = this.client_();
    if (!client) throw new Error('Account service unavailable — try reloading the app');
    const { error } = await client.auth.signUp({ email, password });
    if (error) throw error;
  },

  async signIn(email, password) {
    const client = this.client_();
    if (!client) throw new Error('Account service unavailable — try reloading the app');
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async signOut() {
    const client = this.client_();
    if (!client) return;
    await client.auth.signOut();
  },

  // The profile_id sent to every sync RPC — derived from the locally active
  // profile (see Store.profileSyncId).
  profileId() {
    return Store.profileSyncId();
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
    const { error } = await client.rpc('sync_push_addons', { p_addons: addons, p_profile_id: this.profileId() });
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
      .eq('profile_id', this.profileId())
      .order('sort_order');
    if (error) throw error;
    return data || [];
  },

  // Same canonical form the TV app uses (strip trailing slash and
  // /manifest.json) so URL variations don't duplicate addons across devices.
  canonicalAddonUrl(url) {
    const trimmed = String(url || '').trim().replace(/\/+$/, '');
    const queryStart = trimmed.indexOf('?');
    const path = queryStart >= 0 ? trimmed.slice(0, queryStart) : trimmed;
    const query = queryStart >= 0 ? trimmed.slice(queryStart) : '';
    return path.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '') + query;
  },

  // Pull addons that exist remotely but not locally, install them, then push
  // the merged list back so both sides end up in sync. Returns the number of
  // addons newly added locally.
  async syncAddons() {
    const remote = await this.pullAddons();
    let added = 0;
    for (const r of remote) {
      const canonical = this.canonicalAddonUrl(r.url);
      if (Addons.list().some((a) => this.canonicalAddonUrl(a.manifestUrl) === canonical)) continue;
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

  // ---------------- Library sync ----------------
  async pushLibrary() {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const items = Store.getLibrary().map((it) => ({
      content_id: it.content_id,
      content_type: it.content_type,
      name: it.name || '',
      poster: it.poster || null,
      poster_shape: it.poster_shape || 'POSTER',
      background: it.background || null,
      description: it.description || null,
      release_info: it.release_info || null,
      imdb_rating: it.imdb_rating ?? null,
      genres: it.genres || [],
      addon_base_url: it.addon_base_url || null,
      added_at: it.added_at || Date.now(),
    }));
    if (!items.length) return;
    const { error } = await client.rpc('sync_push_library', { p_items: items, p_profile_id: this.profileId() });
    if (error) throw error;
  },

  async pullLibrary() {
    const client = this.client_();
    if (!client) return [];
    const session = await this.getSession();
    if (!session) return [];
    const { data, error } = await client.rpc('sync_pull_library', {
      p_profile_id: this.profileId(),
      p_limit: 500,
      p_offset: 0,
    });
    if (error) throw error;
    return data || [];
  },

  // Remove library items server-side (mirrors a local removal — without this
  // the next pull would resurrect them, since push is upsert-only).
  // keys: [{ content_id, content_type }]
  async deleteLibraryItems(keys) {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    if (!keys || !keys.length) return;
    const { error } = await client.rpc('sync_delete_library', { p_keys: keys, p_profile_id: this.profileId() });
    if (error) throw error;
  },

  // The remote library is authoritative: local adds/removes push immediately
  // (pushLibrary/deleteLibraryItems), so a routine sync just replaces the
  // local list with the server's — the same semantics the TV app uses, which
  // is what lets deletions made on other devices stick. The one exception is
  // a first sync against an empty account, where local items seed the server.
  async syncLibrary() {
    const remote = await this.pullLibrary();
    const local = Store.getLibrary();
    if (!remote.length && local.length) {
      await this.pushLibrary();
      return local;
    }
    const items = remote
      .map((r) => ({
        content_id: r.content_id,
        content_type: r.content_type,
        name: r.name,
        poster: r.poster,
        poster_shape: r.poster_shape,
        background: r.background,
        description: r.description,
        release_info: r.release_info,
        imdb_rating: r.imdb_rating,
        genres: r.genres || [],
        addon_base_url: r.addon_base_url,
        added_at: r.added_at,
      }))
      .sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
    Store.saveLibrary(items);
    return items;
  },

  // ---------------- Watch progress sync ----------------
  async pushWatchProgress(entries) {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const list = entries || Object.values(Store.getWatchProgress());
    if (!list.length) return;
    const payload = list.map((e) => ({
      content_id: e.content_id,
      content_type: e.content_type,
      video_id: e.video_id,
      season: e.season ?? null,
      episode: e.episode ?? null,
      position: e.position || 0,
      duration: e.duration || 0,
      last_watched: e.last_watched || Date.now(),
      progress_key: e.progress_key,
    }));
    const { error } = await client.rpc('sync_push_watch_progress', { p_entries: payload, p_profile_id: this.profileId() });
    if (error) throw error;
  },

  async pullWatchProgress() {
    const client = this.client_();
    if (!client) return [];
    const session = await this.getSession();
    if (!session) return [];
    const { data, error } = await client.rpc('sync_pull_watch_progress', { p_profile_id: this.profileId() });
    if (error) throw error;
    return data || [];
  },

  // Merge remote watch-progress entries into the local map (newer
  // last_watched wins), then push the merged set back.
  async syncWatchProgress() {
    const remote = await this.pullWatchProgress();
    const local = Store.getWatchProgress();
    for (const r of remote) {
      const existing = local[r.progress_key];
      if (!existing || (r.last_watched || 0) >= (existing.last_watched || 0)) {
        local[r.progress_key] = {
          content_id: r.content_id,
          content_type: r.content_type,
          video_id: r.video_id,
          season: r.season,
          episode: r.episode,
          position: r.position,
          duration: r.duration,
          last_watched: r.last_watched,
          progress_key: r.progress_key,
        };
      }
    }
    Store.saveWatchProgress(local);
    await this.pushWatchProgress();
    return local;
  },

  // ---------------- Watched history sync ----------------
  async pushWatchedItems(items) {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const list = items || Store.getWatchedItems();
    if (!list.length) return;
    const payload = list.map((it) => ({
      content_id: it.content_id,
      content_type: it.content_type,
      title: it.title || '',
      season: it.season ?? null,
      episode: it.episode ?? null,
      watched_at: it.watched_at || Date.now(),
    }));
    const { error } = await client.rpc('sync_push_watched_items', { p_items: payload, p_profile_id: this.profileId() });
    if (error) throw error;
  },

  async pullWatchedItems() {
    const client = this.client_();
    if (!client) return [];
    const session = await this.getSession();
    if (!session) return [];
    const { data, error } = await client.rpc('sync_pull_watched_items', {
      p_profile_id: this.profileId(),
      p_page: 1,
      p_page_size: 200,
    });
    if (error) throw error;
    return data || [];
  },

  // Merge remote watched-history entries into the local list (newer
  // watched_at wins for the same content/season/episode), then push back.
  async syncWatchedItems() {
    const remote = await this.pullWatchedItems();
    const local = Store.getWatchedItems();
    const key = (it) => `${it.content_type}:${it.content_id}:${it.season ?? ''}:${it.episode ?? ''}`;
    const map = new Map();
    for (const it of local) map.set(key(it), it);
    for (const r of remote) {
      const k = key(r);
      const existing = map.get(k);
      if (!existing || (r.watched_at || 0) >= (existing.watched_at || 0)) {
        map.set(k, {
          content_id: r.content_id,
          content_type: r.content_type,
          title: r.title,
          season: r.season,
          episode: r.episode,
          watched_at: r.watched_at,
        });
      }
    }
    const merged = [...map.values()].sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0)).slice(0, 200);
    Store.saveWatchedItems(merged);
    await this.pushWatchedItems(merged);
    return merged;
  },

  // ---------------- Profile sync ----------------
  async pushProfiles() {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const profiles = Store.getProfiles().map((p) => ({
      profile_index: Store.profileSyncId(p.index),
      name: p.name,
      avatar_color_hex: p.avatarColorHex || '#1E88E5',
      avatar_id: p.avatarId || null,
      avatar_url: p.avatarUrl || null,
    }));
    const { error } = await client.rpc('sync_push_profiles', { p_client_max_profiles: 5, p_profiles: profiles });
    if (error) throw error;
  },

  async pullProfiles() {
    const client = this.client_();
    if (!client) return [];
    const session = await this.getSession();
    if (!session) return [];
    const { data, error } = await client.rpc('sync_pull_profiles');
    if (error) throw error;
    return data || [];
  },

  // Merge remote profiles into the local list (remote name/avatar wins for
  // shared indices, new remote profiles are added locally), then push the
  // merged list back so both sides converge. Returns the merged profiles.
  async syncProfiles() {
    const remote = await this.pullProfiles();
    if (!remote.length) {
      await this.pushProfiles();
      return Store.getProfiles();
    }
    const local = Store.getProfiles();
    const map = new Map();
    for (const p of local) map.set(p.index, p);
    for (const r of remote) {
      const index = r.profile_index - 1;
      if (index < 0) continue;
      map.set(index, {
        index,
        name: r.name,
        avatarColorHex: r.avatar_color_hex,
        avatarId: r.avatar_id || undefined,
        avatarUrl: r.avatar_url || undefined,
      });
    }
    const merged = [...map.values()].sort((a, b) => a.index - b.index);
    Store.saveProfiles(merged);
    await this.pushProfiles();
    return merged;
  },

  // After a local rename/add/delete: pull first so profiles created on other
  // devices survive the push (sync_push_profiles deletes rows missing from
  // the pushed set), but let local values win for indices this device knows.
  // deletedIndex stops a just-deleted profile being re-added from remote.
  async syncProfilesAfterLocalChange(deletedIndex = null) {
    const remote = await this.pullProfiles();
    const local = Store.getProfiles();
    const map = new Map();
    for (const r of remote) {
      const index = r.profile_index - 1;
      if (index < 0 || index === deletedIndex) continue;
      map.set(index, {
        index,
        name: r.name,
        avatarColorHex: r.avatar_color_hex,
        avatarId: r.avatar_id || undefined,
        avatarUrl: r.avatar_url || undefined,
      });
    }
    for (const p of local) map.set(p.index, p);
    const merged = [...map.values()].sort((a, b) => a.index - b.index);
    Store.saveProfiles(merged);
    await this.pushProfiles();
    return merged;
  },

  // Delete all server-side data (addons, library, progress, history, etc.)
  // for a profile that's being removed locally.
  async deleteProfileData(profileIndex) {
    const client = this.client_();
    if (!client) return;
    const session = await this.getSession();
    if (!session) return;
    const { error } = await client.rpc('sync_delete_profile_data', { p_profile_id: Store.profileSyncId(profileIndex) });
    if (error) throw error;
  },

  // ---------------- Sync everything for the active profile ----------------
  async syncAll() {
    await this.syncProfiles();
    const addedAddons = await this.syncAddons();
    await this.syncLibrary();
    await this.syncWatchProgress();
    await this.syncWatchedItems();
    return { addedAddons };
  },
};
