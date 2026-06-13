// Main UI controller — tab navigation, catalog rendering, detail view, sheets.
const App = {
  state: {
    activeTab: 'home',
    searchTimer: null,
  },

  el(id) {
    return document.getElementById(id);
  },

  async init() {
    this.bindTabBar();
    this.bindSearch();
    this.bindAddonsScreen();
    this.bindSettingsScreen();
    this.bindSheet();
    this.bindProfileButton();
    this.bindLibraryScreen();

    await this.maybeImportFromHash();

    await Addons.ensureDefaults();
    this.renderHome();
    this.renderAddonsScreen();
    this.renderSettingsScreen();
    this.renderLibraryScreen();
    this.updateProfileUI();

    if (Account.isConfigured()) {
      const session = await Account.getSession();
      if (session) {
        Account.syncAll()
          .then((res) => {
            this.renderAddonsScreen();
            this.renderHome();
            this.renderLibraryScreen();
            if (res.addedAddons) this.toast(`Synced ${res.addedAddons} new addon(s)`);
          })
          .catch((e) => console.warn('Initial sync failed', e));
      }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  },

  // ---------------- Backup / restore ----------------
  async maybeImportFromHash() {
    const match = location.hash.match(/config=([^&]+)/);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const config = Store.parseConfigBase64(decodeURIComponent(match[1]));
      const ok = confirm(`Import ${(config.addonUrls || []).length} addon(s) and settings from this link? This will be added to your current setup.`);
      if (!ok) return;
      await this.importConfig(config);
      this.toast('Config imported');
    } catch (e) {
      console.warn('hash config import failed', e);
      this.toast('Could not read config link');
    }
  },

  async importConfig(config) {
    Store.applySettingsFromConfig(config);
    let added = 0;
    for (const url of config.addonUrls || []) {
      try {
        await Addons.add(url);
        added++;
      } catch (e) {
        // already installed or unreachable — skip
      }
    }
    this.renderHome();
    this.renderAddonsScreen();
    this.renderSettingsScreen();
    return added;
  },

  // ---------------- Tabs ----------------
  bindTabBar() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
  },

  switchTab(tab) {
    this.state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    this.el(`screen-${tab}`).classList.add('active');
    if (tab === 'library') this.renderLibraryScreen();
  },

  // ---------------- Toast ----------------
  toast(msg) {
    const t = this.el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  },

  // ---------------- Sheet ----------------
  bindSheet() {
    this.el('sheet-backdrop').addEventListener('click', (e) => {
      if (e.target === this.el('sheet-backdrop')) this.hideSheet();
    });
  },

  showSheet(html) {
    this.el('sheet-content').innerHTML = html;
    this.el('sheet-backdrop').classList.add('show');
  },

  hideSheet() {
    this.el('sheet-backdrop').classList.remove('show');
    this._simklPollToken = null;
  },

  // ---------------- Home / Catalog ----------------
  async renderHome() {
    const container = this.el('home-content');
    const addons = Addons.list();
    const sections = [];
    for (const addon of addons) {
      for (const type of addon.manifest.types || []) {
        for (const catalog of Addons.catalogsFor(addon, type)) {
          const requiresExtra = (catalog.extra || []).some((e) => e.isRequired);
          if (requiresExtra) continue;
          sections.push({ addon, type, catalog });
        }
      }
    }

    // Continue Watching / Last Watched come from the Streamfield account's
    // synced history (works locally too); SIMKL rows are the fallback for
    // SIMKL users with no local/synced history yet.
    const watchedItems = Store.getWatchedItems();
    const progressEntries = Object.values(Store.getWatchProgress());
    const hasAccountRows = watchedItems.length > 0 || progressEntries.some((p) => p.position > 0 && p.duration > 0);
    const showSimklRows = Simkl.isConnected() && !hasAccountRows;

    if (!sections.length && !hasAccountRows && !showSimklRows) {
      container.innerHTML = `<div class="empty">No catalogs available. Add an addon in the Addons tab.</div>`;
      return;
    }

    const rowSectionHtml = (id, title, source) => `
        <section class="catalog-section" id="cat-${id}">
          <div class="section-head">
            <h2>${title}</h2>
            <span class="source">${source}</span>
          </div>
          <div class="catalog-row" id="cat-row-${id}">
            <div class="status"><div class="spinner"></div>Loading…</div>
          </div>
        </section>`;

    let topRowsHtml = '';
    if (hasAccountRows) {
      topRowsHtml = rowSectionHtml('continue', 'Continue Watching', 'Streamfield')
        + rowSectionHtml('lastwatched', 'Last Watched', 'Streamfield');
    } else if (showSimklRows) {
      topRowsHtml = rowSectionHtml('continue', 'Continue Watching', 'SIMKL')
        + rowSectionHtml('lastwatched', 'Last Watched', 'SIMKL');
    }

    container.innerHTML = topRowsHtml + sections
      .map((s, i) => `
        <section class="catalog-section" id="cat-${i}">
          <div class="section-head">
            <h2>${escapeHtml(s.catalog.name || s.catalog.id)}</h2>
            <span class="source">${escapeHtml(s.addon.manifest.name)}</span>
          </div>
          <div class="catalog-row" id="cat-row-${i}">
            <div class="status"><div class="spinner"></div>Loading…</div>
          </div>
        </section>
      `)
      .join('');

    if (hasAccountRows) {
      this.loadHomeRow('continue', () => this.getAccountContinueWatching());
      this.loadHomeRow('lastwatched', () => this.getAccountLastWatched());
    } else if (showSimklRows) {
      this.loadHomeRow('continue', () => Simkl.getContinueWatching());
      this.loadHomeRow('lastwatched', () => Simkl.getLastWatched());
    }
    sections.forEach((s, i) => this.loadCatalogRow(s, i));
  },

  async loadHomeRow(id, fetchItems) {
    const section = this.el(`cat-${id}`);
    if (!section) return;
    const row = this.el(`cat-row-${id}`);
    try {
      const items = await fetchItems();
      if (!items.length) {
        section.remove();
        return;
      }
      row.innerHTML = items.map((m) => posterCardHtml(m)).join('');
      row.querySelectorAll('.poster-card').forEach((card, idx) => {
        card.addEventListener('click', () => this.openDetail(items[idx]));
      });
    } catch (e) {
      console.warn(`SIMKL row "${id}" load failed`, e);
      section.remove();
    }
  },

  async loadCatalogRow(section, index) {
    const row = this.el(`cat-row-${index}`);
    try {
      const metas = await Stremio.getCatalog(section.addon, section.type, section.catalog.id);
      if (!metas.length) {
        this.el(`cat-${index}`).remove();
        return;
      }
      row.innerHTML = metas.map((m) => posterCardHtml(m)).join('');
      row.querySelectorAll('.poster-card').forEach((card, idx) => {
        card.addEventListener('click', () => this.openDetail({ ...metas[idx], type: section.type }));
      });
    } catch (e) {
      console.warn('catalog load failed', section.addon.manifest.name, section.catalog.id, e);
      this.el(`cat-${index}`).remove();
    }
  },

  // ---------------- Streamfield home rows ----------------
  // Short-lived meta cache so Continue Watching / Last Watched (which often
  // reference the same titles) don't refetch meta on every home render.
  cachedMeta(type, id) {
    if (!this._metaCache) this._metaCache = new Map();
    const key = `${type}:${id}`;
    if (!this._metaCache.has(key)) {
      this._metaCache.set(key, Stremio.getMeta(type, id).catch(() => null));
    }
    return this._metaCache.get(key);
  },

  // Resume entries from watch progress (real positions come from the TV app
  // via the account), plus SIMKL-style "next episode" entries derived from
  // the watched history for shows with no in-progress entry.
  async getAccountContinueWatching(limit = 10) {
    const inProgress = Object.values(Store.getWatchProgress())
      .filter((p) => p.position > 0 && p.duration > 0 && p.position / p.duration < 0.95)
      .sort((a, b) => (b.last_watched || 0) - (a.last_watched || 0));

    const latestEpisode = new Map();
    for (const it of Store.getWatchedItems()) {
      if (it.content_type !== 'series' || it.season == null || it.episode == null || it.season === 0) continue;
      const cur = latestEpisode.get(it.content_id);
      if (!cur || (it.watched_at || 0) > (cur.watched_at || 0)) latestEpisode.set(it.content_id, it);
    }

    const out = [];
    const seenShows = new Set();

    for (const p of inProgress.slice(0, limit)) {
      try {
        const type = p.content_type === 'series' ? 'series' : 'movie';
        const meta = await this.cachedMeta(type, p.content_id);
        const baseName = (meta && meta.name) || p.content_id;
        const suffix = p.season != null && p.episode != null ? ` — S${p.season}E${p.episode}` : '';
        const pct = Math.round((p.position / p.duration) * 100);
        out.push({ id: p.content_id, type, name: `${baseName}${suffix} · ${pct}%`, poster: meta && meta.poster, _ts: p.last_watched || 0 });
        seenShows.add(p.content_id);
      } catch (e) {
        console.warn('continue-watching: skipping item', e);
      }
    }

    for (const [contentId, seed] of latestEpisode) {
      if (out.length >= limit) break;
      if (seenShows.has(contentId)) continue;
      try {
        const meta = await this.cachedMeta('series', contentId);
        if (!meta || !Array.isArray(meta.videos)) continue;
        const next = meta.videos
          .filter((v) => v.season > 0 && v.episode > 0)
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
          .find((v) => v.season > seed.season || (v.season === seed.season && v.episode > seed.episode));
        if (!next) continue;
        out.push({ id: contentId, type: 'series', name: `${meta.name || seed.title} — S${next.season}E${next.episode}`, poster: meta.poster, _ts: seed.watched_at || 0 });
      } catch (e) {
        console.warn('continue-watching: skipping show', e);
      }
    }

    return out.sort((a, b) => b._ts - a._ts).slice(0, limit);
  },

  // Most recent watched-history entries (movies and episodes), newest first.
  async getAccountLastWatched(limit = 10) {
    const items = Store.getWatchedItems().slice(0, limit);
    const out = [];
    for (const it of items) {
      const type = it.content_type === 'series' ? 'series' : 'movie';
      const meta = await this.cachedMeta(type, it.content_id);
      const baseName = (meta && meta.name) || it.title;
      const suffix = it.season != null && it.episode != null ? ` — S${it.season}E${it.episode}` : '';
      out.push({ id: it.content_id, type, name: `${baseName}${suffix}`, poster: (meta && meta.poster) || '' });
    }
    return out;
  },

  // ---------------- Search ----------------
  bindSearch() {
    this.el('search-input').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      clearTimeout(this.state.searchTimer);
      if (!q) {
        this.el('search-content').innerHTML = '';
        return;
      }
      this.el('search-content').innerHTML = `<div class="status"><div class="spinner"></div>Searching…</div>`;
      this.state.searchTimer = setTimeout(() => this.runSearch(q), 450);
    });
  },

  async runSearch(query) {
    const container = this.el('search-content');
    try {
      const results = await Stremio.search(query);
      if (!results.length) {
        container.innerHTML = `<div class="empty">No results for "${escapeHtml(query)}"</div>`;
        return;
      }
      container.innerHTML = `<div class="grid-results">${results.map((m) => posterCardHtml(m)).join('')}</div>`;
      container.querySelectorAll('.poster-card').forEach((card, idx) => {
        card.addEventListener('click', () => this.openDetail(results[idx]));
      });
    } catch (e) {
      container.innerHTML = `<div class="empty">Search failed: ${escapeHtml(e.message)}</div>`;
    }
  },

  // ---------------- Detail ----------------
  async openDetail(metaStub) {
    this.switchTab('detail');
    const container = this.el('detail-content');
    container.innerHTML = detailSkeletonHtml(metaStub);
    this.el('detail-back').addEventListener('click', () => this.switchTab(this._lastTab || 'home'));

    let meta = metaStub;
    try {
      const full = await Stremio.getMeta(metaStub.type, metaStub.id);
      if (full) meta = { ...metaStub, ...full };
    } catch (e) {
      console.warn('meta fetch failed', e);
    }

    container.innerHTML = detailHtml(meta);
    this.el('detail-back').addEventListener('click', () => this.switchTab(this._lastTab || 'home'));

    const libBtn = this.el('detail-library-btn');
    if (libBtn) libBtn.addEventListener('click', () => this.toggleLibrary(meta));

    if (meta.type === 'series' && Array.isArray(meta.videos) && meta.videos.length) {
      this.bindSeriesPicker(meta);
    } else {
      const btn = this.el('detail-find-streams');
      if (btn) {
        const trackInfo = /^tt\d+/.test(meta.id || '')
          ? { kind: 'movie', imdbId: meta.id, title: meta.name, year: parseYear(meta.releaseInfo) }
          : null;
        btn.addEventListener('click', () => this.openStreams('movie', meta.id, meta.name, trackInfo));
      }
    }
  },

  bindSeriesPicker(meta) {
    const seasons = [...new Set(meta.videos.map((v) => v.season).filter((s) => s !== undefined))].sort((a, b) => a - b);
    const seasonSelect = this.el('season-select');
    seasonSelect.innerHTML = seasons.map((s) => `<option value="${s}">${s === 0 ? 'Specials' : `Season ${s}`}</option>`).join('');

    const renderEpisodes = (season) => {
      const eps = meta.videos.filter((v) => v.season === season).sort((a, b) => a.episode - b.episode);
      this.el('episode-list').innerHTML = eps
        .map(
          (v) => `
          <div class="episode-row" data-id="${escapeAttr(v.id)}" data-title="${escapeAttr(`${meta.name} – S${v.season}E${v.episode}`)}">
            <span class="ep-num">${v.episode}</span>
            <span class="ep-title">${escapeHtml(v.title || v.name || `Episode ${v.episode}`)}</span>
          </div>`
        )
        .join('');
      this.el('episode-list').querySelectorAll('.episode-row').forEach((row, idx) => {
        row.addEventListener('click', () => {
          this.el('episode-list').querySelectorAll('.episode-row').forEach((r) => r.classList.remove('active'));
          row.classList.add('active');
          const v = eps[idx];
          const trackInfo = /^tt\d+/.test(meta.id || '')
            ? { kind: 'episode', showImdbId: meta.id, title: meta.name, year: parseYear(meta.releaseInfo), season: v.season, episode: v.episode }
            : null;
          this.openStreams('series', row.dataset.id, row.dataset.title, trackInfo);
        });
      });
    };

    const defaultSeason = seasons.find((s) => s > 0) ?? seasons[0];
    seasonSelect.value = String(defaultSeason);
    seasonSelect.addEventListener('change', () => renderEpisodes(Number(seasonSelect.value)));
    renderEpisodes(defaultSeason);
  },

  // ---------------- Streams ----------------
  async openStreams(type, id, title, trackInfo) {
    this.showSheet(`<h3>${escapeHtml(title)}</h3><div class="status"><div class="spinner"></div>Finding streams…</div>`);
    try {
      const streams = await Stremio.getStreams(type, id);
      if (!streams.length) {
        this.showSheet(`<h3>${escapeHtml(title)}</h3><div class="empty">No streams found from your installed addons.</div>`);
        return;
      }
      const playerName = Player.currentPlayerName();
      this.showSheet(`
        <h3>${escapeHtml(title)}</h3>
        <p class="steps" style="margin-bottom:10px">Tap a stream to open it in <strong>${escapeHtml(playerName)}</strong>.</p>
        ${streams.map((s, i) => streamItemHtml(s, i)).join('')}
      `);
      document.querySelectorAll('#sheet .stream-item').forEach((item, idx) => {
        item.addEventListener('click', () => {
          const s = streams[idx];
          if (!s.url) {
            this.toast('No direct URL for this stream (torrent-only) — try a debrid-enabled addon');
            return;
          }
          this.hideSheet();
          Player.launch(s.url, title);
          this.trackWatched(trackInfo);
          this.recordWatch(type, id, title, trackInfo);
        });
      });
    } catch (e) {
      this.showSheet(`<h3>${escapeHtml(title)}</h3><div class="empty">Failed to load streams: ${escapeHtml(e.message)}</div>`);
    }
  },

  // ---------------- SIMKL tracking ----------------
  trackWatched(trackInfo) {
    if (!trackInfo || !Simkl.isConnected()) return;
    let promise;
    if (trackInfo.kind === 'movie') {
      promise = Simkl.markMovieWatched(trackInfo.imdbId, trackInfo.title, trackInfo.year);
    } else if (trackInfo.kind === 'episode') {
      promise = Simkl.markEpisodeWatched(trackInfo.showImdbId, trackInfo.title, trackInfo.year, trackInfo.season, trackInfo.episode);
    }
    if (!promise || typeof promise.then !== 'function') return;
    promise.then((result) => {
      if (result.ok) {
        this.toast('Marked as watched on SIMKL');
      } else if (result.reason === 'not_found') {
        this.toast('SIMKL didn\'t recognize this title');
        console.warn('SIMKL: title not found', trackInfo, result.data);
      } else {
        this.toast('SIMKL sync failed');
        console.warn('SIMKL sync error', trackInfo, result);
      }
    });
  },

  // ---------------- Watch progress / watched history ----------------
  // Records that a stream was opened, both as a "watched history" entry and
  // as a "continue watching" progress entry (position/duration are unknown
  // since playback happens in an external player, so they're recorded as 0 —
  // this still lets other devices/profiles see what was recently played).
  recordWatch(type, id, title, trackInfo) {
    const now = Date.now();
    let contentId = id;
    const contentType = type === 'series' ? 'series' : 'movie';
    let season;
    let episode;

    if (trackInfo && trackInfo.kind === 'episode') {
      contentId = trackInfo.showImdbId;
      season = trackInfo.season;
      episode = trackInfo.episode;
    } else if (trackInfo && trackInfo.kind === 'movie') {
      contentId = trackInfo.imdbId;
    }

    const watchedKey = (it) => `${it.content_type}:${it.content_id}:${it.season ?? ''}:${it.episode ?? ''}`;
    const watchedEntry = { content_id: contentId, content_type: contentType, title, season, episode, watched_at: now };
    const watchedItems = Store.getWatchedItems().filter((it) => watchedKey(it) !== watchedKey(watchedEntry));
    watchedItems.unshift(watchedEntry);
    Store.saveWatchedItems(watchedItems.slice(0, 200));
    this.renderLibraryScreen();
    this.renderHome();
    Account.pushWatchedItems([watchedEntry]).catch((e) => console.warn('Watched history sync failed', e));

    // Key format matches the Streamfield TV app's progressKey() so this entry
    // lands on the same Continue Watching row instead of a duplicate one.
    const progressKey = (season != null && episode != null) ? `${contentId}_s${season}e${episode}` : contentId;
    const progress = Store.getWatchProgress();
    const existing = progress[progressKey];
    progress[progressKey] = {
      content_id: contentId,
      content_type: contentType,
      video_id: id,
      season,
      episode,
      // Preserve any position/duration already known for this entry (e.g.
      // synced down from a device that tracks real playback progress) —
      // we only know "this was opened just now", not a position.
      position: existing?.position || 0,
      duration: existing?.duration || 0,
      last_watched: now,
      progress_key: progressKey,
    };
    Store.saveWatchProgress(progress);
    Account.pushWatchProgress([progress[progressKey]]).catch((e) => console.warn('Watch progress sync failed', e));
  },

  // ---------------- Library (bookmarks) ----------------
  isInLibrary(meta) {
    return Store.getLibrary().some((it) => it.content_id === meta.id && it.content_type === meta.type);
  },

  toggleLibrary(meta) {
    const items = Store.getLibrary();
    const idx = items.findIndex((it) => it.content_id === meta.id && it.content_type === meta.type);
    if (idx >= 0) {
      items.splice(idx, 1);
      this.toast('Removed from library');
      Account.deleteLibraryItems([{ content_id: meta.id, content_type: meta.type }])
        .catch((e) => console.warn('Library delete sync failed', e));
    } else {
      items.unshift({
        content_id: meta.id,
        content_type: meta.type,
        name: meta.name,
        poster: meta.poster || '',
        poster_shape: meta.posterShape ? String(meta.posterShape).toUpperCase() : 'POSTER',
        background: meta.background || '',
        description: meta.description || '',
        release_info: meta.releaseInfo || '',
        imdb_rating: meta.imdbRating ? Number(meta.imdbRating) : null,
        genres: meta.genres || meta.genre || [],
        addon_base_url: '',
        added_at: Date.now(),
      });
      this.toast('Added to library');
    }
    Store.saveLibrary(items);
    const btn = this.el('detail-library-btn');
    if (btn) btn.textContent = idx >= 0 ? '+ Add to Library' : '✓ In Library';
    this.renderLibraryScreen();
    Account.pushLibrary().catch((e) => console.warn('Library sync push failed', e));
  },

  // ---------------- Addons screen ----------------
  bindAddonsScreen() {
    this.el('addon-add-btn').addEventListener('click', async () => {
      const input = this.el('addon-url-input');
      const url = input.value.trim();
      if (!url) return;
      try {
        const entry = await Addons.add(url);
        input.value = '';
        this.toast(`Added ${entry.manifest.name}`);
        this.renderAddonsScreen();
        this.renderHome();
        Account.pushAddons().catch((e) => console.warn('Account sync push failed', e));
      } catch (e) {
        this.toast(e.message);
      }
    });
  },

  renderAddonsScreen() {
    const list = Addons.list();
    const container = this.el('addon-list');
    if (!list.length) {
      container.innerHTML = `<div class="empty">No addons installed yet.</div>`;
      return;
    }
    container.innerHTML = list
      .map(
        (a) => `
        <div class="addon-item" data-url="${escapeAttr(a.manifestUrl)}">
          <img src="${escapeAttr(a.manifest.logo || '')}" onerror="this.style.visibility='hidden'" alt="">
          <div class="meta">
            <div class="name">${escapeHtml(a.manifest.name)}</div>
            <div class="types">${(a.manifest.types || []).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}${(a.manifest.resources || []).map((r) => `<span>${escapeHtml(typeof r === 'string' ? r : r.name)}</span>`).join('')}</div>
          </div>
          <button class="btn-ghost danger remove-addon">Remove</button>
        </div>`
      )
      .join('');

    container.querySelectorAll('.remove-addon').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const url = e.target.closest('.addon-item').dataset.url;
        Addons.remove(url);
        this.renderAddonsScreen();
        this.renderHome();
        Account.pushAddons().catch((e2) => console.warn('Account sync push failed', e2));
      });
    });
  },

  // ---------------- Library screen ----------------
  bindLibraryScreen() {
    document.querySelectorAll('#screen-library .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#screen-library .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        this.state.libraryTab = btn.dataset.seg;
        this.renderLibraryScreen();
      });
    });
  },

  renderLibraryScreen() {
    const tab = this.state.libraryTab || 'list';
    const container = this.el('library-content');

    if (tab === 'list') {
      const items = Store.getLibrary();
      if (!items.length) {
        container.innerHTML = `<div class="empty">Your library is empty. Open a title and tap "Add to Library" to save it here.</div>`;
        return;
      }
      container.innerHTML = `<div class="grid-results">${items.map((it) => posterCardHtml(it)).join('')}</div>`;
      container.querySelectorAll('.poster-card').forEach((card, idx) => {
        const it = items[idx];
        card.addEventListener('click', () => this.openDetail({ id: it.content_id, type: it.content_type, name: it.name, poster: it.poster }));
      });
    } else {
      const items = Store.getWatchedItems();
      if (!items.length) {
        container.innerHTML = `<div class="empty">No watch history yet — items you open will show up here.</div>`;
        return;
      }
      container.innerHTML = items.map((it) => historyRowHtml(it)).join('');
      container.querySelectorAll('.history-row').forEach((row, idx) => {
        const it = items[idx];
        row.addEventListener('click', () => this.openDetail({ id: it.content_id, type: it.content_type, name: it.title }));
      });
    }
  },

  // ---------------- Profiles ----------------
  bindProfileButton() {
    this.el('profile-btn').addEventListener('click', () => this.showProfileSheet());
  },

  updateProfileUI() {
    const profile = Store.getActiveProfile();
    this.el('profile-btn-avatar').innerHTML = profileAvatarHtml(profile);
    const display = this.el('account-profile-display');
    if (display) display.textContent = profile.name;
  },

  switchProfile(index) {
    if (Store.getActiveProfileIndex() === index) {
      this.hideSheet();
      return;
    }
    Store.setActiveProfileIndex(index);
    Addons.reload();
    this.updateProfileUI();
    this.renderHome();
    this.renderAddonsScreen();
    this.renderLibraryScreen();
    this.hideSheet();
    if (Account.isConfigured()) {
      Account.syncAll()
        .then(() => {
          this.renderAddonsScreen();
          this.renderHome();
          this.renderLibraryScreen();
        })
        .catch((e) => console.warn('Profile sync failed', e));
    }
  },

  showProfileSheet() {
    const profiles = Store.getProfiles();
    const active = Store.getActiveProfileIndex();
    this.showSheet(`
      <h3>Profiles</h3>
      ${profiles
        .map(
          (p) => `
        <div class="sheet-option profile-row" data-index="${p.index}">
          <div class="profile-row-main">
            ${profileAvatarHtml(p)}
            <span>${escapeHtml(p.name)}</span>
          </div>
          <div class="profile-row-actions">
            ${p.index === active ? '<span class="check">✓</span>' : ''}
            <button class="btn-ghost profile-avatar-pick" data-index="${p.index}">🎭</button>
            <button class="btn-ghost profile-rename" data-index="${p.index}">✏️</button>
            ${profiles.length > 1 ? `<button class="btn-ghost danger profile-delete" data-index="${p.index}">🗑</button>` : ''}
          </div>
        </div>`
        )
        .join('')}
      <div class="btn-row" style="margin-top:14px">
        ${Store.canAddProfile() ? '<button class="btn-secondary" id="profile-add-btn">+ New Profile</button>' : '<p class="steps">Profile limit reached (5).</p>'}
      </div>
    `);

    this.el('sheet-content').querySelectorAll('.profile-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.switchProfile(Number(row.dataset.index));
      });
    });

    this.el('sheet-content').querySelectorAll('.profile-avatar-pick').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showAvatarPicker(Number(btn.dataset.index));
      });
    });

    this.el('sheet-content').querySelectorAll('.profile-rename').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const all = Store.getProfiles();
        const p = all.find((x) => x.index === index);
        const name = prompt('Profile name', p.name);
        if (!name || !name.trim()) return;
        p.name = name.trim();
        Store.saveProfiles(all);
        if (index === Store.getActiveProfileIndex()) this.updateProfileUI();
        // Pull-merge-push: a bare push would delete any profiles this device
        // doesn't know about yet (the RPC removes rows missing from the set).
        Account.syncProfilesAfterLocalChange().catch((e2) => console.warn('Profile sync failed', e2));
        this.showProfileSheet();
      });
    });

    this.el('sheet-content').querySelectorAll('.profile-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const all = Store.getProfiles();
        if (all.length <= 1) return;
        const p = all.find((x) => x.index === index);
        if (!confirm(`Delete profile "${p.name}"? This removes its addons, library, and history.`)) return;
        const remaining = all.filter((x) => x.index !== index);
        Store.saveProfiles(remaining);
        Store.clearProfileData(index);
        Account.deleteProfileData(index).catch((e2) => console.warn('Profile delete sync failed', e2));
        Account.syncProfilesAfterLocalChange(index).catch((e2) => console.warn('Profile sync failed', e2));
        if (Store.getActiveProfileIndex() === index) {
          this.switchProfile(remaining[0].index);
        } else {
          this.showProfileSheet();
        }
      });
    });

    const addBtn = this.el('profile-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
      const newIndex = Store.nextProfileIndex();
      if (newIndex === null) {
        this.toast('Profile limit reached (5)');
        return;
      }
      const name = prompt('New profile name');
      if (!name || !name.trim()) return;
      const all = Store.getProfiles();
      all.push({ index: newIndex, name: name.trim(), avatarColorHex: Store.nextAvatarColor() });
      Store.saveProfiles(all);
      Account.syncProfilesAfterLocalChange().catch((e) => console.warn('Profile sync failed', e));
      this.switchProfile(newIndex);
    });
  },

  // ---------------- Avatar picker ----------------
  // Catalog lives in avatars/ (manifest.json + images) and mirrors the
  // Supabase avatar_catalog table the TV app reads — same ids, same files.
  async showAvatarPicker(index) {
    this.showSheet(`<h3>Choose Avatar</h3><div class="status"><div class="spinner"></div>Loading…</div>`);
    try {
      if (!this._avatarManifest) {
        const res = await fetch('avatars/manifest.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this._avatarManifest = await res.json();
      }
      const items = this._avatarManifest;
      this.showSheet(`
        <h3>Choose Avatar</h3>
        <div class="avatar-grid">
          <button class="avatar-cell avatar-none" data-id="" title="No picture (colored initial)"><span>A</span></button>
          ${items.map((a) => `<button class="avatar-cell" data-id="${escapeAttr(a.id)}" data-file="${escapeAttr(a.file)}" title="${escapeAttr(a.name)}"><img src="avatars/${escapeAttr(a.file)}" loading="lazy" alt="${escapeAttr(a.name)}"></button>`).join('')}
        </div>
      `);
      this.el('sheet-content').querySelectorAll('.avatar-cell').forEach((cell) => {
        cell.addEventListener('click', () => {
          const all = Store.getProfiles();
          const p = all.find((x) => x.index === index);
          if (!p) return;
          if (cell.dataset.id) {
            p.avatarId = cell.dataset.id;
            p.avatarUrl = `${AVATAR_BASE_URL}/${cell.dataset.file}`;
          } else {
            delete p.avatarId;
            delete p.avatarUrl;
          }
          Store.saveProfiles(all);
          this.updateProfileUI();
          Account.syncProfilesAfterLocalChange().catch((e) => console.warn('Profile sync failed', e));
          this.showProfileSheet();
        });
      });
    } catch (e) {
      console.warn('avatar manifest load failed', e);
      this.showSheet(`<h3>Choose Avatar</h3><div class="empty">Could not load avatars — check your connection and try again.</div>`);
    }
  },

  // ---------------- Settings screen ----------------
  bindSettingsScreen() {
    const playerSelect = this.el('player-select');
    playerSelect.innerHTML = Object.entries(PLAYER_PRESETS)
      .map(([id, p]) => `<option value="${id}">${escapeHtml(p.name)}</option>`)
      .join('');

    playerSelect.addEventListener('change', () => {
      const settings = Store.getSettings();
      settings.player = playerSelect.value;
      Store.saveSettings(settings);
      this.el('custom-template-wrap').style.display = playerSelect.value === 'custom' ? 'block' : 'none';
    });

    this.el('custom-template-input').addEventListener('change', (e) => {
      const settings = Store.getSettings();
      settings.customTemplate = e.target.value.trim();
      Store.saveSettings(settings);
    });

    this.el('cors-proxy-input').addEventListener('change', (e) => {
      const settings = Store.getSettings();
      settings.corsProxy = e.target.value.trim();
      Store.saveSettings(settings);
    });

    this.el('copy-config-btn').addEventListener('click', () => {
      this.copyToClipboard(Store.exportConfigString(), 'Config copied — paste it somewhere safe');
    });

    this.el('copy-link-btn').addEventListener('click', () => {
      const link = `${location.origin}${location.pathname}#config=${encodeURIComponent(Store.exportConfigBase64())}`;
      this.copyToClipboard(link, 'Share link copied — open it on another device to import');
    });

    this.el('import-config-btn').addEventListener('click', async () => {
      const input = this.el('import-config-input');
      const text = input.value.trim();
      if (!text) return;
      try {
        const config = JSON.parse(text);
        const added = await this.importConfig(config);
        input.value = '';
        this.toast(`Imported (${added} new addon${added === 1 ? '' : 's'})`);
      } catch (e) {
        this.toast('Invalid config JSON');
      }
    });

    this.el('simkl-connect-btn').addEventListener('click', () => this.connectSimkl());
    this.el('simkl-disconnect-btn').addEventListener('click', () => this.disconnectSimkl());
    this.el('simkl-debug-btn').addEventListener('click', () => this.debugSimklWatching());

    this.el('account-signin-btn').addEventListener('click', async () => {
      if (this._signingIn) return;
      const email = this.el('account-email-input').value.trim();
      const password = this.el('account-password-input').value;
      if (!email || !password) return;
      this._signingIn = true;
      try {
        await Account.signIn(email, password);
        this.el('account-password-input').value = '';
        const { addedAddons } = await Account.syncAll();
        this.renderAddonsScreen();
        this.renderHome();
        this.renderLibraryScreen();
        this.updateProfileUI();
        this.toast(addedAddons ? `Signed in — synced ${addedAddons} addon(s)` : 'Signed in');
        this.renderSettingsScreen();
      } catch (e) {
        this.toast(e.message || 'Sign in failed');
      } finally {
        this._signingIn = false;
      }
    });

    this.el('account-signup-btn').addEventListener('click', async () => {
      const email = this.el('account-email-input').value.trim();
      const password = this.el('account-password-input').value;
      if (!email || !password) return;
      try {
        await Account.signUp(email, password);
        this.toast('Account created — check your email to confirm, then sign in');
      } catch (e) {
        this.toast(e.message || 'Sign up failed');
      }
    });

    this.el('account-signout-btn').addEventListener('click', async () => {
      await Account.signOut();
      this.renderSettingsScreen();
    });

    this.el('account-sync-btn').addEventListener('click', async () => {
      try {
        const { addedAddons } = await Account.syncAll();
        this.renderAddonsScreen();
        this.renderHome();
        this.renderLibraryScreen();
        this.updateProfileUI();
        this.toast(addedAddons ? `Synced — ${addedAddons} new addon(s)` : 'Synced');
      } catch (e) {
        this.toast('Sync failed: ' + (e.message || 'unknown error'));
      }
    });

    this.el('account-profiles-btn').addEventListener('click', () => this.showProfileSheet());
  },

  async debugSimklWatching() {
    this.showSheet(`<h3>SIMKL: Watching</h3><div class="status"><div class="spinner"></div>Loading…</div>`);
    try {
      const res = await fetch(`${Simkl.API}/sync/all-items/shows/watching?extended=full&episode_watched_at=yes`, {
        headers: Simkl.headers(),
      });
      if (!res.ok) {
        this.showSheet(`<h3>SIMKL: Watching</h3><div class="empty">Request failed (HTTP ${res.status}). Try reconnecting SIMKL.</div>`);
        return;
      }
      const data = await res.json();
      const shows = Array.isArray(data) ? data : data.shows || [];
      if (!shows.length) {
        this.showSheet(`
          <h3>SIMKL: Watching (0)</h3>
          <div class="empty">
            SIMKL has no shows with status "watching" yet. Tap a stream for an episode in Streamfield, then check
            back here — if it still doesn't appear, the title likely wasn't recognized by SIMKL (watch for a
            "didn't recognize this title" toast).
          </div>
        `);
        return;
      }
      const lines = shows.map((item) => {
        const show = item.show || {};
        const imdb = (show.ids && show.ids.imdb) || '—';
        return `${show.title || '?'}\n  imdb: ${imdb} · status: ${item.status} · watched ${item.watched_episodes_count ?? '?'}/${item.total_episodes_count ?? '?'}`;
      });
      this.showSheet(`
        <h3>SIMKL: Watching (${shows.length})</h3>
        <pre style="white-space:pre-wrap;font-size:12px;line-height:1.7;margin:0">${escapeHtml(lines.join('\n\n'))}</pre>
      `);
    } catch (e) {
      this.showSheet(`<h3>SIMKL: Watching</h3><div class="empty">Error: ${escapeHtml(e.message)}</div>`);
    }
  },

  // ---------------- SIMKL connect ----------------
  async connectSimkl() {
    const clientId = this.el('simkl-client-id-input').value.trim();
    if (!clientId) {
      this.toast('Enter your SIMKL Client ID first');
      return;
    }
    const settings = Store.getSettings();
    settings.simklClientId = clientId;
    Store.saveSettings(settings);

    try {
      const pin = await Simkl.requestPin(clientId);
      const verifyUrl = pin.verification_url || pin.verification_uri || 'https://simkl.com/pin';
      this.showSheet(`
        <h3>Connect SIMKL</h3>
        <p class="steps">
          On any device, go to <a href="${escapeAttr(verifyUrl)}" target="_blank" rel="noopener">${escapeHtml(verifyUrl)}</a>
          and enter this code:
        </p>
        <div class="simkl-pin-code">${escapeHtml(pin.user_code)}</div>
        <div class="status" id="simkl-pin-status"><div class="spinner"></div>Waiting for authorization…</div>
      `);
      this.pollSimklPin(clientId, pin);
    } catch (e) {
      this.toast('Could not start SIMKL connection — check your Client ID');
    }
  },

  pollSimklPin(clientId, pin) {
    const token = {};
    this._simklPollToken = token;
    const interval = (pin.interval || 5) * 1000;
    const deadline = Date.now() + (pin.expires_in || 900) * 1000;

    const tick = async () => {
      if (this._simklPollToken !== token) return; // cancelled (sheet closed)
      if (Date.now() > deadline) {
        this.hideSheet();
        this.toast('SIMKL connection timed out — try again');
        return;
      }
      try {
        const res = await Simkl.pollPin(clientId, pin.user_code);
        if (this._simklPollToken !== token) return;
        if (res.result === 'OK' && res.access_token) {
          const settings = Store.getSettings();
          settings.simklAccessToken = res.access_token;
          Store.saveSettings(settings);
          this._simklPollToken = null;
          this.hideSheet();
          this.toast('Connected to SIMKL');
          this.renderSettingsScreen();
          this.renderHome();
          return;
        }
      } catch (e) {
        // transient — keep polling
      }
      if (this._simklPollToken === token) setTimeout(tick, interval);
    };
    setTimeout(tick, interval);
  },

  disconnectSimkl() {
    const settings = Store.getSettings();
    settings.simklAccessToken = '';
    Store.saveSettings(settings);
    this.toast('Disconnected from SIMKL');
    this.renderSettingsScreen();
    this.renderHome();
  },

  copyToClipboard(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => this.toast(successMessage))
        .catch(() => this.fallbackCopy(text, successMessage));
    } else {
      this.fallbackCopy(text, successMessage);
    }
  },

  fallbackCopy(text, successMessage) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      this.toast(successMessage);
    } catch (e) {
      this.toast('Copy failed — select and copy manually');
    }
    document.body.removeChild(ta);
  },

  renderSettingsScreen() {
    const settings = Store.getSettings();
    this.el('player-select').value = settings.player;
    this.el('custom-template-input').value = settings.customTemplate;
    this.el('cors-proxy-input').value = settings.corsProxy;
    this.el('custom-template-wrap').style.display = settings.player === 'custom' ? 'block' : 'none';
    this.el('simkl-client-id-input').value = settings.simklClientId;
    this.updateProfileUI();

    const connected = Simkl.isConnected();
    this.el('simkl-connected').style.display = connected ? 'block' : 'none';
    this.el('simkl-disconnected').style.display = connected ? 'none' : 'block';

    this.updateAccountUI();
  },

  async updateAccountUI() {
    this.el('account-signedout').style.display = 'none';
    this.el('account-signedin').style.display = 'none';
    if (!Account.isConfigured()) return;

    const session = await Account.getSession();
    if (session) {
      this.el('account-signedin').style.display = 'block';
      this.el('account-email-display').textContent = session.user.email || '';
    } else {
      this.el('account-signedout').style.display = 'block';
    }
  },
};

// Track last non-detail tab so the detail back button knows where to return.
const _origSwitchTab = App.switchTab.bind(App);
App.switchTab = function (tab) {
  if (this.state.activeTab !== 'detail') this._lastTab = this.state.activeTab;
  _origSwitchTab(tab);
};

// ---------------- HTML helpers ----------------
// Absolute base so synced avatar_url values render on every device,
// including the TV app (which displays avatarUrl directly).
const AVATAR_BASE_URL = 'https://98georgelivanos-lab.github.io/NuvGL/avatars';

function profileAvatarHtml(p) {
  if (p.avatarUrl) {
    return `<span class="profile-avatar"><img src="${escapeAttr(p.avatarUrl)}" alt=""></span>`;
  }
  const initial = (p.name || '?').slice(0, 1).toUpperCase();
  return `<span class="profile-avatar" style="background:${escapeAttr(p.avatarColorHex || '#1E88E5')}">${escapeHtml(initial)}</span>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function parseYear(releaseInfo) {
  const m = String(releaseInfo || '').match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

function posterCardHtml(m) {
  const poster = m.poster || '';
  return `
    <div class="poster-card">
      <div class="poster">${poster ? `<img src="${escapeAttr(poster)}" loading="lazy" alt="">` : ''}</div>
      <div class="title">${escapeHtml(m.name)}</div>
    </div>`;
}

function historyRowHtml(it) {
  const sub = it.season != null && it.episode != null ? `S${it.season}E${it.episode}` : (it.content_type === 'series' ? 'Series' : 'Movie');
  const date = it.watched_at ? new Date(it.watched_at).toLocaleString() : '';
  return `
    <div class="history-row">
      <div class="meta">
        <div class="name">${escapeHtml(it.title)}</div>
        <div class="sub">${escapeHtml([sub, date].filter(Boolean).join(' · '))}</div>
      </div>
    </div>`;
}

function detailSkeletonHtml(m) {
  return `
    <div class="detail-hero">
      ${m.poster ? `<img src="${escapeAttr(m.poster)}" alt="">` : ''}
      <button class="icon-btn back-btn" id="detail-back">‹</button>
    </div>
    <div class="detail-body">
      <h1>${escapeHtml(m.name)}</h1>
      <div class="status"><div class="spinner"></div>Loading details…</div>
    </div>`;
}

function detailHtml(meta) {
  const bg = meta.background || meta.poster || '';
  const sub = [meta.releaseInfo, meta.imdbRating ? `★ ${meta.imdbRating}` : null, (meta.genres || meta.genre || []).join(', ') || null]
    .filter(Boolean)
    .join('  ·  ');

  let body = '';
  if (meta.type === 'series' && Array.isArray(meta.videos) && meta.videos.length) {
    body = `
      <div class="episode-picker">
        <select id="season-select"></select>
      </div>
      <div class="episode-list" id="episode-list"></div>
      <p class="steps">Tap an episode to find streams.</p>`;
  } else {
    body = `<button class="btn-primary" id="detail-find-streams">Find Streams</button>`;
  }

  const inLibrary = App.isInLibrary(meta);

  return `
    <div class="detail-hero">
      ${bg ? `<img src="${escapeAttr(bg)}" alt="">` : ''}
      <button class="icon-btn back-btn" id="detail-back">‹</button>
    </div>
    <div class="detail-body">
      <h1>${escapeHtml(meta.name)}</h1>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
      ${meta.description ? `<div class="desc">${escapeHtml(meta.description)}</div>` : ''}
      <div class="btn-row">
        <button class="btn-secondary" id="detail-library-btn">${inLibrary ? '✓ In Library' : '+ Add to Library'}</button>
      </div>
      ${body}
    </div>`;
}

function streamItemHtml(s, i) {
  const name = s.name || s.title || `Stream ${i + 1}`;
  const title = s.title && s.title !== name ? s.title : '';
  const badges = [];
  if (s._addon) badges.push(s._addon);
  if (!s.url) badges.push('No direct link');
  if (s.behaviorHints && s.behaviorHints.bingeGroup) badges.push(s.behaviorHints.bingeGroup);
  return `
    <div class="stream-item">
      <div class="play-icon">▶</div>
      <div class="info">
        <div class="name">${escapeHtml(name)}</div>
        ${title ? `<div class="title">${escapeHtml(title)}</div>` : ''}
        <div class="badges">${badges.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>
      </div>
    </div>`;
}

document.addEventListener('DOMContentLoaded', () => App.init());
