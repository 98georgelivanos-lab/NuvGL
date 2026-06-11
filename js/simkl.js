// SIMKL tracking integration — device-code (PIN) auth + watch history sync.
//
// This is the same OAuth "PIN" flow TV apps use, so a future Android TV
// build can authorize against the same SIMKL account and share Continue
// Watching / history with this web app — no custom backend needed.
const Simkl = {
  API: 'https://api.simkl.com',

  isConnected() {
    const s = Store.getSettings();
    return !!(s.simklClientId && s.simklAccessToken);
  },

  headers() {
    const s = Store.getSettings();
    return {
      'Content-Type': 'application/json',
      'simkl-api-key': s.simklClientId,
      Authorization: `Bearer ${s.simklAccessToken}`,
    };
  },

  // ---------------- Device-code (PIN) auth ----------------
  async requestPin(clientId) {
    const res = await fetch(`${this.API}/oauth/pin?client_id=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error('Could not start SIMKL authorization');
    const data = await res.json();
    if (data.result !== 'OK' || !data.user_code) throw new Error('Unexpected response from SIMKL');
    return data; // { user_code, verification_url, device_code, expires_in, interval }
  },

  async pollPin(clientId, userCode) {
    const res = await fetch(`${this.API}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(clientId)}`);
    return res.json(); // { result: 'OK', access_token } or { result: 'KO', message }
  },

  // ---------------- Sync / scrobble ----------------
  // Returns { ok, reason?, data? } — ok is only true if SIMKL actually
  // recognized the title (HTTP 2xx alone doesn't guarantee that; SIMKL
  // returns a 200/201 with a `not_found` list for unrecognized ids).
  async addToHistory(payload) {
    if (!this.isConnected()) return { ok: false, reason: 'not_connected' };
    let res;
    try {
      res = await fetch(`${this.API}/sync/history`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn('SIMKL history sync failed', e);
      return { ok: false, reason: 'network_error' };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no/invalid body */ }
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status, data };
    const nf = (data && data.not_found) || {};
    const notFoundCount = (nf.movies || []).length + (nf.shows || []).length + (nf.episodes || []).length;
    if (notFoundCount > 0) return { ok: false, reason: 'not_found', data };
    return { ok: true, data };
  },

  markMovieWatched(imdbId, title, year) {
    if (!imdbId) return;
    const movie = { ids: { imdb: imdbId } };
    if (title) movie.title = title;
    if (year) movie.year = year;
    return this.addToHistory({ movies: [movie] });
  },

  markEpisodeWatched(showImdbId, title, year, season, episode) {
    if (!showImdbId || season === undefined || episode === undefined) return;
    const show = { ids: { imdb: showImdbId } };
    if (title) show.title = title;
    if (year) show.year = year;
    show.seasons = [{ number: Number(season), episodes: [{ number: Number(episode) }] }];
    return this.addToHistory({ shows: [show] });
  },

  // ---------------- Continue watching ----------------
  // Returns poster-card-shaped items for shows the user is mid-way through,
  // pointing at the next unwatched episode (best-effort — falls back to
  // skipping a show entirely if SIMKL/addon data doesn't line up).
  async getContinueWatching(limit = 10) {
    if (!this.isConnected()) return [];
    let items;
    try {
      const res = await fetch(`${this.API}/sync/all-items/shows/watching?extended=full&episode_watched_at=yes`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      items = Array.isArray(data) ? data : data.shows || [];
    } catch (e) {
      console.warn('SIMKL continue-watching fetch failed', e);
      return [];
    }

    const out = [];
    for (const item of items.slice(0, limit)) {
      try {
        const show = item.show || {};
        const imdbId = show.ids && show.ids.imdb;
        if (!imdbId) continue;

        const watched = new Set();
        for (const season of item.seasons || []) {
          for (const ep of season.episodes || []) {
            watched.add(`${season.number}:${ep.number}`);
          }
        }

        const meta = await Stremio.getMeta('series', imdbId);
        if (!meta || !Array.isArray(meta.videos)) continue;

        const next = meta.videos
          .filter((v) => v.season > 0 && v.episode > 0)
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
          .find((v) => !watched.has(`${v.season}:${v.episode}`));
        if (!next) continue;

        out.push({
          id: imdbId,
          type: 'series',
          name: `${meta.name || show.title} — S${next.season}E${next.episode}`,
          poster: meta.poster,
        });
      } catch (e) {
        // skip this show, don't let one bad entry break the whole row
        console.warn('SIMKL continue-watching: skipping show', e);
      }
    }
    return out;
  },

  // ---------------- Last watched ----------------
  // Most-recently-watched movies (completed) and episodes (from in-progress
  // shows), newest first. Best-effort like getContinueWatching — bounded to
  // recently-active items rather than a user's entire history.
  async getLastWatched(limit = 10) {
    if (!this.isConnected()) return [];
    const candidates = [];

    try {
      const res = await fetch(`${this.API}/sync/all-items/movies/completed?extended=full`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json();
        const movies = Array.isArray(data) ? data : data.movies || [];
        for (const item of movies) {
          const movie = item.movie || {};
          const imdbId = movie.ids && movie.ids.imdb;
          if (!imdbId || !item.last_watched_at) continue;
          candidates.push({ imdbId, type: 'movie', title: movie.title, watchedAt: item.last_watched_at });
        }
      }
    } catch (e) {
      console.warn('SIMKL last-watched movies fetch failed', e);
    }

    try {
      const res = await fetch(`${this.API}/sync/all-items/shows/watching?extended=full&episode_watched_at=yes`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json();
        const shows = Array.isArray(data) ? data : data.shows || [];
        for (const item of shows) {
          const show = item.show || {};
          const imdbId = show.ids && show.ids.imdb;
          if (!imdbId) continue;
          let latest = null;
          for (const season of item.seasons || []) {
            for (const ep of season.episodes || []) {
              if (ep.watched_at && (!latest || ep.watched_at > latest.watched_at)) {
                latest = { season: season.number, episode: ep.number, watched_at: ep.watched_at };
              }
            }
          }
          if (!latest) continue;
          candidates.push({
            imdbId, type: 'series', title: show.title,
            watchedAt: latest.watched_at, season: latest.season, episode: latest.episode,
          });
        }
      }
    } catch (e) {
      console.warn('SIMKL last-watched shows fetch failed', e);
    }

    candidates.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));

    const out = [];
    for (const c of candidates.slice(0, limit)) {
      try {
        const meta = await Stremio.getMeta(c.type === 'movie' ? 'movie' : 'series', c.imdbId);
        const baseName = (meta && meta.name) || c.title;
        out.push({
          id: c.imdbId,
          type: c.type,
          name: c.season != null ? `${baseName} — S${c.season}E${c.episode}` : baseName,
          poster: meta && meta.poster,
        });
      } catch (e) {
        console.warn('SIMKL last-watched: skipping item', e);
      }
    }
    return out;
  },
};
