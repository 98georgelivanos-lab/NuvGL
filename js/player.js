// External player launchers for iOS, using the same URL schemes Nuvio's
// native app uses (see ExternalPlayerPlatform.ios.kt in NuvioMobile).
const PLAYER_PRESETS = {
  outplayer: {
    name: 'Outplayer',
    build: ({ encodedUrl, encodedTitle }) =>
      `outplayer://x-callback-url/play?url=${encodedUrl}&filename=${encodedTitle}`,
  },
  infuse: {
    name: 'Infuse',
    build: ({ encodedUrl, encodedTitle }) =>
      `infuse://x-callback-url/play?url=${encodedUrl}&filename=${encodedTitle}`,
  },
  vlc: {
    name: 'VLC',
    build: ({ encodedUrl }) =>
      `vlc-x-callback://x-callback-url/stream?url=${encodedUrl}`,
  },
  vidhub: {
    name: 'VidHub',
    build: ({ encodedUrl }) =>
      `open-vidhub://x-callback-url/open?url=${encodedUrl}`,
  },
  custom: {
    name: 'Custom',
    build: ({ url, encodedUrl, title, encodedTitle }, template) =>
      template
        .replaceAll('{encodedUrl}', encodedUrl)
        .replaceAll('{url}', url)
        .replaceAll('{encodedTitle}', encodedTitle)
        .replaceAll('{title}', title),
  },
};

const Player = {
  presets: PLAYER_PRESETS,

  buildLaunchUrl(streamUrl, title) {
    const settings = Store.getSettings();
    const preset = PLAYER_PRESETS[settings.player] || PLAYER_PRESETS.outplayer;
    const ctx = {
      url: streamUrl,
      encodedUrl: encodeURIComponent(streamUrl),
      title: title || 'Stream',
      encodedTitle: encodeURIComponent(title || 'Stream'),
    };
    if (settings.player === 'custom') {
      return preset.build(ctx, settings.customTemplate || '');
    }
    return preset.build(ctx);
  },

  launch(streamUrl, title) {
    const target = this.buildLaunchUrl(streamUrl, title);
    window.location.href = target;
  },

  currentPlayerName() {
    const settings = Store.getSettings();
    const preset = PLAYER_PRESETS[settings.player] || PLAYER_PRESETS.outplayer;
    return preset.name;
  },
};
