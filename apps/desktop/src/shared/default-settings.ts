// The settings every client starts from (desktop main, apps/webtv). Pure: the caller passes what depends on the OS.
import type { DeepPartial, Settings } from './contract';

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Live TV (livetv-spec-final.md §15). Main-side; contract.ts Settings.live types the keys the renderer
// shows (the reminder rows in Settings).
export interface LiveSettings {
  // "Libérer le tuner avant de changer de chaîne": auto learns break-before-make per server.
  release: 'auto' | 'always' | 'never';
  // Learned per server (Auto): break-before-make until this epoch (7 days).
  releaseFirst: Record<string, { until: number }>;
  // "Mise en pause du direct" (§8.8): the timeshift window in minutes, 0 = off.
  timeshiftMinutes: 0 | 15 | 30 | 60 | 120;
  // Reminders (§9.6): minutes before the start, and "Changer de chaîne au rappel".
  reminderLeadMin: 0 | 1 | 2 | 5 | 10;
  reminderAutoTune: boolean;
}

// What the settings file holds: the shared Settings plus the main-only sections.
// defaultsVersion: the last one-time migration of changed defaults run on this file (see SettingsService).
export type StoredSettings = Settings & { live: LiveSettings; defaultsVersion: number };

export function defaultSettings(downloadsFolder: string): StoredSettings {
  return {
    ui: {
      theme: 'graphite',
      accent: 'blue',
      reduceMotion: false,
      reduceTransparency: false,
      sidebarCollapsed: false,
      sidebarHidden: [],
      homeRows: [],
      startPage: 'home',
      confirmQuitDuringPlayback: false,
      density: 'comfortable',
      posterSize: 100,
      cardRatings: false,
      cardAges: false,
      cardQuality: false,
      cardTitles: true,
      heroEnabled: true,
      heroAutoplay: true,
      hero: { source: 'auto', types: 'both', libraries: [], collections: [], excludeGenres: [], count: 5, intervalS: 8, hideWatched: false },
      zoom: 100,
      libraryView: 'poster',
      librarySort: 'SortName',
      librarySortDesc: false,
      fpsMeter: false,
      language: 'auto',
      mergeContinue: true,
      filesOnHome: false,
      continueHidden: [],
      shortcuts: {},
      onboarded: false,
    },
    playback: {
      player: 'auto',
      mpvPath: '',
      useMpvConfig: false,
      hwdec: 'auto-safe',
      hdrPassthrough: true,
      hdrAutoSwitch: false,
      matchRefreshRate: false,
      smoothMotion: false,
      audioExclusive: false,
      spdif: [],
      maxBitrateMbps: 120,
      maxResolution: 0,
      forceTranscode: false,
      volumeBoost: false,
      nightMode: false,
      dialogueBoost: false,
      subtitleStyle: { size: 100, font: 'Geist', color: '#FFFFFF', border: 'outline', position: 100, overrideAss: false, scaleWithVideo: false },
      // '' = the server user's preference (B04).
      preferredAudioLanguage: '',
      preferredSubtitleLanguage: '',
      subtitleSearchLanguage: '',
      subtitleMode: 'foreign',
      autoPlayNext: true,
      startFullscreen: true,
      inWindowVideo: true,
      skipIntro: 'ask',
      skipCredits: 'ask',
      skipRecap: 'ask',
      skipPreview: 'ask',
      skipCommercial: 'ask',
      aniskip: false,
      communitySegments: false,
      maxBitrateRemoteMbps: 120,
      defaultSpeed: 1,
      upNextSeconds: 10,
      resume: 'resume',
      seekShortS: 10,
      seekLongS: 60,
      pauseOnMinimize: false,
      playerByType: { movie: 'default', episode: 'default', music: 'default', live: 'default' },
      audioDevice: 'auto',
      normalize: false,
      alwaysForced: true,
      preferSdh: false,
      audioDescription: 'avoid',
      mpvArgs: '',
      aspect: 'fit',
      cinemaMode: false,
      // B26: subtitle sync belongs to a file; "per series" is a choice, not the default.
      rememberScopes: { speed: 'global', audioDelay: 'title', subtitleDelay: 'off', aspect: 'title' },
    },
    downloads: {
      folder: downloadsFolder,
      maxConcurrent: 2,
    },
    system: { hardwareAcceleration: true, comicCacheGb: 2, plainTextVault: false },
    torrents: { url: '', username: '', notifyOnComplete: true, scanOnComplete: true, magnetHandler: false, libraryMap: [] },
    trakt: { offServers: [] },
    remote: { allowControl: true },
    cast: { discovery: true, relay: true, allowHevc: false, dolby: false },
    updates: { autoCheck: true },
    window: {},
    windows: { closeToTray: false, launchAtStartup: false, trayHintShown: false, notifyDownloads: true, notifyNewEpisodes: true, notifyAdmin: true },
    live: { release: 'auto', releaseFirst: {}, timeshiftMinutes: 15, reminderLeadMin: 2, reminderAutoTune: false },
    photos: { map: { enabled: false, tileUrl: OSM_TILES, attribution: '© OpenStreetMap contributors' } },
    music: { replayGain: 'album', preampDb: 0, fallbackDb: -6, preventClipping: true, gapless: true, resumeQueue: true, lyricsProvider: 'server', eq: { bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: 0 }, source: '' },
    defaultsVersion: 2,
  };
}


// Deep merge of a settings patch: unknown keys are dropped, arrays and scalars replace.
export function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    // Ignore unknown keys from the renderer; the optional window keys have no default.
    if (!(key in out) && key !== 'bounds' && key !== 'maximized' && key !== 'mini') continue;
    const current = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current, value as DeepPartial<typeof current>);
    } else if (current && typeof current === 'object' && !Array.isArray(current)) {
      // A section never becomes a scalar or null (a hand-edited file, a bad patch): the current one stays.
      continue;
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
