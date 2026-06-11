// Tiny localStorage helpers — all app state lives here, nothing server-side.
const STORAGE_KEYS = {
  addons: 'nuvio.addons',
  settings: 'nuvio.settings',
};

const DEFAULT_SETTINGS = {
  player: 'outplayer',
  customTemplate: 'outplayer://x-callback-url/play?url={encodedUrl}&filename={encodedTitle}',
  corsProxy: '',
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
};
