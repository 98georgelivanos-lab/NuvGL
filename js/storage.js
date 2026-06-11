// Tiny localStorage helpers — all app state lives here, nothing server-side.
const STORAGE_KEYS = {
  addons: 'streamfield.addons',
  settings: 'streamfield.settings',
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

const DEFAULT_SETTINGS = {
  player: 'outplayer',
  customTemplate: 'outplayer://x-callback-url/play?url={encodedUrl}&filename={encodedTitle}',
  corsProxy: '',
  simklClientId: '',
  simklAccessToken: '',
};

const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
];

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
  getAddons() {
    return loadJSON(STORAGE_KEYS.addons, []);
  },
  saveAddons(addons) {
    saveJSON(STORAGE_KEYS.addons, addons);
  },
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...loadJSON(STORAGE_KEYS.settings, {}) };
  },
  saveSettings(settings) {
    saveJSON(STORAGE_KEYS.settings, settings);
  },

  // ---------------- Backup / restore ----------------
  // Config is intentionally tiny (addon manifest URLs + settings) so it can be
  // copied as text, put in a QR code, or stuck on the end of a URL. No account needed.
  exportConfig() {
    return {
      v: 1,
      addonUrls: this.getAddons().map((a) => a.manifestUrl),
      settings: this.getSettings(),
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
      this.saveSettings({ ...DEFAULT_SETTINGS, ...config.settings });
    }
  },
};
