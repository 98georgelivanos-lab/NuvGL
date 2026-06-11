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

    await Addons.ensureDefaults();
    this.renderHome();
    this.renderAddonsScreen();
    this.renderSettingsScreen();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
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

    if (!sections.length) {
      container.innerHTML = `<div class="empty">No catalogs available. Add an addon in the Addons tab.</div>`;
      return;
    }

    container.innerHTML = sections
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

    sections.forEach((s, i) => this.loadCatalogRow(s, i));
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

    if (meta.type === 'series' && Array.isArray(meta.videos) && meta.videos.length) {
      this.bindSeriesPicker(meta);
    } else {
      const btn = this.el('detail-find-streams');
      if (btn) {
        btn.addEventListener('click', () => this.openStreams('movie', meta.id, meta.name));
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
      this.el('episode-list').querySelectorAll('.episode-row').forEach((row) => {
        row.addEventListener('click', () => {
          this.el('episode-list').querySelectorAll('.episode-row').forEach((r) => r.classList.remove('active'));
          row.classList.add('active');
          this.openStreams('series', row.dataset.id, row.dataset.title);
        });
      });
    };

    const defaultSeason = seasons.find((s) => s > 0) ?? seasons[0];
    seasonSelect.value = String(defaultSeason);
    seasonSelect.addEventListener('change', () => renderEpisodes(Number(seasonSelect.value)));
    renderEpisodes(defaultSeason);
  },

  // ---------------- Streams ----------------
  async openStreams(type, id, title) {
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
        });
      });
    } catch (e) {
      this.showSheet(`<h3>${escapeHtml(title)}</h3><div class="empty">Failed to load streams: ${escapeHtml(e.message)}</div>`);
    }
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
      });
    });
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
  },

  renderSettingsScreen() {
    const settings = Store.getSettings();
    this.el('player-select').value = settings.player;
    this.el('custom-template-input').value = settings.customTemplate;
    this.el('cors-proxy-input').value = settings.corsProxy;
    this.el('custom-template-wrap').style.display = settings.player === 'custom' ? 'block' : 'none';
  },
};

// Track last non-detail tab so the detail back button knows where to return.
const _origSwitchTab = App.switchTab.bind(App);
App.switchTab = function (tab) {
  if (this.state.activeTab !== 'detail') this._lastTab = this.state.activeTab;
  _origSwitchTab(tab);
};

// ---------------- HTML helpers ----------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function posterCardHtml(m) {
  const poster = m.poster || '';
  return `
    <div class="poster-card">
      <div class="poster">${poster ? `<img src="${escapeAttr(poster)}" loading="lazy" alt="">` : ''}</div>
      <div class="title">${escapeHtml(m.name)}</div>
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

  return `
    <div class="detail-hero">
      ${bg ? `<img src="${escapeAttr(bg)}" alt="">` : ''}
      <button class="icon-btn back-btn" id="detail-back">‹</button>
    </div>
    <div class="detail-body">
      <h1>${escapeHtml(meta.name)}</h1>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
      ${meta.description ? `<div class="desc">${escapeHtml(meta.description)}</div>` : ''}
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
