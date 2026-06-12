// Tiny localStorage helpers — all app state lives here, nothing server-side.
const STORAGE_PREFIX = 'streamfield';

const STORAGE_KEYS = {
  addons: 'streamfield.addons',
  settings: 'streamfield.settings',
  profiles: 'streamfield.profiles',
  activeProfile: 'streamfield.activeProfile',
};

// One-time migration from the old "Nuvio Web" storage keys, so renaming the
// app doesn't wipe out anyone's existing addons/settings.
const LEGACY_STORAGE_KEYS = {
  addons: 'nuvio.addons',
  settings: 'nuvio.settings',
};

(function migrateLegacyStorage() {
  try {
    if (localStorage.getItem(STORAGE_KEYS.addons) === null) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.addons);
      if (legacy !== null) localStorage.setItem(STORAGE_KEYS.addons, legacy);
    }
    if (localStorage.getItem(STORAGE_KEYS.settings) === null) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.settings);
      if (legacy !== null) localStorage.setItem(STORAGE_KEYS.settings, legacy);
    }
  } catch (e) {
    // ignore (e.g. storage unavailable)
  }
})();

function profileStorageKey(base, profileIndex) {
  return `${STORAGE_PREFIX}.${base}.${profileIndex}`;
}

// One-time migration to multi-profile storage: the original single-profile
// addon list (under STORAGE_KEYS.addons) becomes profile 0's addon list.
(function migrateToProfiles() {
  try {
    if (localStorage.getItem(STORAGE_KEYS.profiles) !== null) return;
    const profiles = [{ index: 0, name: 'Profile 1', avatarColorHex: '#1E88E5' }];
    localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(profiles));
    localStorage.setItem(STORAGE_KEYS.activeProfile, '0');
    const legacyAddons = localStorage.getItem(STORAGE_KEYS.addons);
    if (legacyAddons !== null) {
      localStorage.setItem(profileStorageKey('addons', 0), legacyAddons);
    }
  } catch (e) {
    // ignore
  }
})();

const DEFAULT_SETTINGS = {
  player: 'outplayer',
  customTemplate: 'outplayer://x-callback-url/play?url={encodedUrl}&filename={encodedTitle}',
  corsProxy: '',
  simklClientId: '',
  simklAccessToken: '',
  supabaseUrl: '',
  supabaseAnonKey: '',
};

const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
];

const PROFILE_AVATAR_COLORS = ['#1E88E5', '#E53935', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1'];

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const Store = {
  // ---------------- Profiles ----------------
  getProfiles() {
    const profiles = loadJSON(STORAGE_KEYS.profiles, []);
    return profiles.length ? profiles : [{ index: 0, name: 'Profile 1', avatarColorHex: '#1E88E5' }];
  },

  saveProfiles(profiles) {
    saveJSON(STORAGE_KEYS.profiles, profiles);
  },

  getActiveProfileIndex() {
    const profiles = this.getProfiles();
    const idx = loadJSON(STORAGE_KEYS.activeProfile, 0);
    return profiles.some((p) => p.index === idx) ? idx : profiles[0].index;
  },

  setActiveProfileIndex(index) {
    saveJSON(STORAGE_KEYS.activeProfile, index);
  },

  getActiveProfile() {
    const idx = this.getActiveProfileIndex();
    return this.getProfiles().find((p) => p.index === idx) || this.getProfiles()[0];
  },

  // The numeric profile_id used by the Supabase sync RPCs (1-based; profile
  // index 0 maps to profile_id 1, matching the data already synced before
  // multi-profile support existed).
  profileSyncId(index) {
    return (index ?? this.getActiveProfileIndex()) + 1;
  },

  nextProfileIndex() {
    const profiles = this.getProfiles();
    return profiles.length ? Math.max(...profiles.map((p) => p.index)) + 1 : 0;
  },

  nextAvatarColor() {
    const idx = this.getProfiles().length;
    return PROFILE_AVATAR_COLORS[idx % PROFILE_AVATAR_COLORS.length];
  },

  // Wipe a profile's local addon/library/progress/history data (used when
  // deleting a profile).
  clearProfileData(index) {
    ['addons', 'library', 'watchProgress', 'watchedItems'].forEach((base) => {
      localStorage.removeItem(profileStorageKey(base, index));
    });
  },

  // ---------------- Addons (per-profile) ----------------
  getAddons(profileIndex) {
    return loadJSON(profileStorageKey('addons', profileIndex ?? this.getActiveProfileIndex()), []);
  },
  saveAddons(addons, profileIndex) {
    saveJSON(profileStorageKey('addons', profileIndex ?? this.getActiveProfileIndex()), addons);
  },

  // ---------------- Library / bookmarks (per-profile) ----------------
  getLibrary(profileIndex) {
    return loadJSON(profileStorageKey('library', profileIndex ?? this.getActiveProfileIndex()), []);
  },
  saveLibrary(items, profileIndex) {
    saveJSON(profileStorageKey('library', profileIndex ?? this.getActiveProfileIndex()), items);
  },

  // ---------------- Watch progress (per-profile, keyed by progress_key) ----------------
  getWatchProgress(profileIndex) {
    return loadJSON(profileStorageKey('watchProgress', profileIndex ?? this.getActiveProfileIndex()), {});
  },
  saveWatchProgress(map, profileIndex) {
    saveJSON(profileStorageKey('watchProgress', profileIndex ?? this.getActiveProfileIndex()), map);
  },

  // ---------------- Watched history (per-profile) ----------------
  getWatchedItems(profileIndex) {
    return loadJSON(profileStorageKey('watchedItems', profileIndex ?? this.getActiveProfileIndex()), []);
  },
  saveWatchedItems(items, profileIndex) {
    saveJSON(profileStorageKey('watchedItems', profileIndex ?? this.getActiveProfileIndex()), items);
  },

  // ---------------- Settings (global, not per-profile) ----------------
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...loadJSON(STORAGE_KEYS.settings, {}) };
  },
  saveSettings(settings) {
    saveJSON(STORAGE_KEYS.settings, settings);
  },

  // ---------------- Backup / restore ----------------
  // Config is intentionally tiny (addon manifest URLs + settings) so it can be
  // copied as text, put in a QR code, or stuck on the end of a URL. No account needed.
  // Covers the active profile's addons plus device-wide settings (player choice,
  // CORS proxy, etc.) — none of which live in the Supabase sync schema.
  //
  // The SIMKL access token is deliberately excluded — it's a credential for
  // your SIMKL account, and shouldn't end up in a copy/pasted blob or share
  // link. Each device should connect to SIMKL itself via the PIN flow.
  exportConfig() {
    const settings = { ...this.getSettings() };
    delete settings.simklAccessToken;
    return {
      v: 1,
      addonUrls: this.getAddons().map((a) => a.manifestUrl),
      settings,
    };
  },

  exportConfigString() {
    return JSON.stringify(this.exportConfig());
  },

  exportConfigBase64() {
    const json = this.exportConfigString();
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  },

  parseConfigBase64(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const json = decodeURIComponent(escape(atob(s)));
    return JSON.parse(json);
  },

  applySettingsFromConfig(config) {
    if (config && config.settings) {
      // Preserve this device's own SIMKL connection — imported configs never
      // carry an access token (see exportConfig), so don't let merging wipe
      // out an existing one.
      const current = this.getSettings();
      this.saveSettings({ ...DEFAULT_SETTINGS, ...config.settings, simklAccessToken: current.simklAccessToken });
    }
  },
};
