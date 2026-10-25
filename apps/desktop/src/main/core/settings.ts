import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { ACCENTS, THEMES, ASPECT_MODES, HERO_COUNTS, HERO_INTERVALS, HERO_SOURCES, LIBRARY_SORTS, SUBTITLE_FONTS, type DeepPartial, type HwDec, type Settings } from '../../shared/contract';
import { sanitizeEq } from '../../shared/equalizer';
import { isMpvPathShape } from '../../shared/mpv-args';
import { repairOverrides, validateImport } from '../../shared/shortcuts';
import { t } from '../i18n';
import { JsonStore } from './json-store';
import { defaultSettings as sharedDefaults, merge, OSM_TILES, type LiveSettings, type StoredSettings } from '../../shared/default-settings';

export type { LiveSettings, StoredSettings } from '../../shared/default-settings';
export { OSM_TILES } from '../../shared/default-settings';

export function defaultSettings(): StoredSettings {
  // Linux: the XDG videos folder (XDG_VIDEOS_DIR, localised), which may not be ~/Videos.
  return sharedDefaults(process.platform === 'win32' ? path.join(os.homedir(), 'Videos', 'Wicaby') : path.join(app.getPath('videos'), 'Wicaby'));
}

// Version 1 (0.4.2): files written before it still hold the old defaults the user never changed.
// French audio and subtitles (B04) become the server's preference, and the per-series subtitle delay
// (B26) becomes off when no remember scope was touched. Values the user picked stay.
function migrateDefaults(stored: DeepPartial<StoredSettings>, next: StoredSettings): void {
  const version = typeof stored.defaultsVersion === 'number' ? stored.defaultsVersion : 0;
  // Version 2 (0.10.8): Smooth Playback shipped on in 0.10.7 and every file written then holds it; it is off now.
  if (version < 2 && stored.playback?.smoothMotion === true) next.playback.smoothMotion = false;
  if (version >= 1) return;
  const p = stored.playback;
  if (p?.preferredAudioLanguage === 'fre' && p.preferredSubtitleLanguage === 'fre') {
    next.playback.preferredAudioLanguage = '';
    next.playback.preferredSubtitleLanguage = '';
  }
  const rs = p?.rememberScopes;
  if (rs?.speed === 'global' && rs.audioDelay === 'title' && rs.subtitleDelay === 'title' && rs.aspect === 'title') next.playback.rememberScopes.subtitleDelay = 'off';
}

// The only mpv executables Wicaby will run (version probe, device list, playback):
// absolute, local drive, not UNC, named mpv.exe (Linux: absolute, named mpv), and an existing file.
export function isSafeMpvPath(p: unknown): p is string {
  if (!isMpvPathShape(p, process.platform)) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}


// A map tile template main may fetch: http(s), a host, no credentials, {z} {x} {y} each once in the path or query.
export function isTileTemplate(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 300 || /\s/.test(v)) return false;
  if (!['{z}', '{x}', '{y}'].every((k) => v.split(k).length === 2)) return false;
  try {
    const u = new URL(v.replace(/\{([zxy])\}/g, '0'));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

const SPDIF_CODECS = new Set(['ac3', 'eac3', 'dts', 'dts-hd', 'truehd']);

export class SettingsService extends EventEmitter {
  private store: JsonStore<StoredSettings>;

  constructor(file: string) {
    super();
    // Each main-process feature (and the main window) subscribes once; the ceiling still catches a real leak.
    this.setMaxListeners(32);
    this.store = new JsonStore<StoredSettings>(file, defaultSettings());
    // Fill keys added in newer versions and migrate renamed values.
    const stored = this.store.value as DeepPartial<StoredSettings>;
    const next = merge(defaultSettings(), stored);
    // merge() drops keys the defaults do not have: the learned servers are copied as they are (sanitized below).
    next.live.releaseFirst = (stored.live?.releaseFirst ?? {}) as LiveSettings['releaseFirst'];
    // A binding a newer build made invalid (a new default key, a removed action) drops alone, not the whole map.
    next.ui.shortcuts = repairOverrides(keepShortcuts(stored, next.ui.shortcuts));
    migrateDefaults(stored, next);
    // Onboarding spec 4: a file written before the wizard existed is an install that is already set up.
    if (stored.ui && typeof stored.ui === 'object' && !('onboarded' in stored.ui)) next.ui.onboarded = true;
    next.defaultsVersion = 2;
    this.store.set(sanitize(next));
  }

  get value(): Settings {
    return this.store.value;
  }

  get live(): LiveSettings {
    return this.store.value.live;
  }

  update(patch: DeepPartial<Settings>): Settings {
    const before = this.store.value.live.release;
    const merged = merge(this.store.value, patch as DeepPartial<StoredSettings>);
    merged.ui.shortcuts = keepShortcuts(patch, merged.ui.shortcuts);
    const next = sanitize(merged, this.store.value);
    // Picking Auto again forgets what Auto learned.
    if (next.live.release === 'auto' && before !== 'auto') next.live.releaseFirst = {};
    this.store.set(next);
    this.emit('change', next);
    return next;
  }

  // Learned by live-session.ts (a busy tuner in Auto); null forgets it. Not a user change: no event.
  setReleaseFirst(serverId: string, until: number | null): void {
    const live = this.store.value.live;
    const releaseFirst = { ...live.releaseFirst };
    if (until === null) delete releaseFirst[serverId];
    else releaseFirst[serverId] = { until };
    this.store.set({ ...this.store.value, live: { ...live, releaseFirst } });
  }

  // Import: a whole document, validated like any other; the window placement stays.
  replace(doc: unknown): Settings {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(t('errors.settings.invalidFile'));
    const merged = merge(defaultSettings(), doc as DeepPartial<StoredSettings>);
    merged.ui.shortcuts = keepShortcuts(doc, merged.ui.shortcuts);
    const next = sanitize(merged);
    next.window = this.store.value.window;
    // An import or a reset never runs the first-run setup again.
    next.ui.onboarded = this.store.value.ui.onboarded;
    // Consent to unencrypted sign-ins is given on this machine, never by a file.
    next.system.plainTextVault = this.store.value.system.plainTextVault;
    // What Auto learned belongs to this machine's network, not to the file.
    next.live.releaseFirst = this.store.value.live.releaseFirst;
    this.store.set(next);
    this.emit('change', next);
    return next;
  }

  // Back to defaults; the qBittorrent connection is an account, not a preference, and stays.
  reset(): Settings {
    return this.replace({ torrents: this.store.value.torrents });
  }

  flush(): void {
    this.store.flush();
  }
}

// merge() drops keys the defaults lack, and the shortcut map is keyed by action id: a patch that
// carries it replaces the whole map (sanitize() then validates it).
function keepShortcuts(patch: unknown, current: Settings['ui']['shortcuts']): Settings['ui']['shortcuts'] {
  const ui = (patch as { ui?: { shortcuts?: unknown } } | null)?.ui;
  return ui && 'shortcuts' in ui ? (ui.shortcuts as Settings['ui']['shortcuts']) : current;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

// Fields added with the expanded settings panes.
function sanitizeExtras(s: Settings, d: Settings): void {
  const u = s.ui;
  u.startPage = typeof u.startPage === 'string' && /^(home|favorites|library:[A-Za-z0-9_-]{1,64})$/.test(u.startPage) ? u.startPage : 'home';
  u.density = oneOf(u.density, ['comfortable', 'compact'] as const, 'comfortable');
  u.posterSize = Math.round(clamp(u.posterSize, 80, 130, d.ui.posterSize));
  u.zoom = Math.round(clamp(u.zoom, 90, 125, d.ui.zoom));
  u.libraryView = oneOf(u.libraryView, ['poster', 'thumb'] as const, 'poster');
  u.librarySort = oneOf(u.librarySort, LIBRARY_SORTS, 'SortName');
  u.language = oneOf(u.language, ['auto', 'fr', 'en'] as const, 'auto');
  for (const k of ['confirmQuitDuringPlayback', 'cardRatings', 'cardAges', 'cardQuality', 'librarySortDesc', 'fpsMeter', 'onboarded', 'filesOnHome'] as const) u[k] = u[k] === true;
  for (const k of ['cardTitles', 'heroEnabled', 'heroAutoplay', 'mergeContinue'] as const) u[k] = u[k] !== false;
  const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  const names = (v: unknown, max: number) => (Array.isArray(v) ? [...new Set(v.filter((x) => short(x, max) && x.length > 0))].slice(0, 64) : []);
  const h = (u.hero = { ...d.ui.hero, ...u.hero });
  h.source = oneOf(h.source, HERO_SOURCES, 'auto');
  h.types = oneOf(h.types, ['both', 'movies', 'shows'] as const, 'both');
  h.libraries = names(h.libraries, 200);
  h.collections = names(h.collections, 200);
  h.excludeGenres = names(h.excludeGenres, 100);
  h.count = oneOf(h.count, HERO_COUNTS, 5);
  h.intervalS = oneOf(h.intervalS, HERO_INTERVALS, 8);
  h.hideWatched = h.hideWatched === true;
  u.sidebarHidden = (Array.isArray(u.sidebarHidden) ? u.sidebarHidden : []).filter((v) => short(v, 20)).slice(0, 20);
  // Capped at 500, the oldest first out (renderer/lib/continue.ts HIDE_CAP).
  u.continueHidden = (Array.isArray(u.continueHidden) ? u.continueHidden : [])
    .filter((e) => e && short(e.key, 400) && e.key.length > 0 && short(e.played, 40))
    .slice(-500)
    .map(({ key, played }) => ({ key, played }));
  // X-04: an invalid map (unknown action, bad combo, conflict) is dropped as a whole.
  u.shortcuts = validateImport(u.shortcuts) ?? {};

  const p = s.playback;
  const skip = ['ask', 'auto', 'off'] as const;
  for (const k of ['skipCredits', 'skipRecap', 'skipPreview', 'skipCommercial'] as const) p[k] = oneOf(p[k], skip, 'ask');
  p.maxBitrateRemoteMbps = clamp(p.maxBitrateRemoteMbps, 1, 400, d.playback.maxBitrateRemoteMbps);
  p.defaultSpeed = oneOf(p.defaultSpeed, [0.75, 1, 1.1, 1.25, 1.5, 2], 1);
  p.upNextSeconds = Math.round(clamp(p.upNextSeconds, 5, 30, d.playback.upNextSeconds));
  p.resume = oneOf(p.resume, ['ask', 'resume', 'start'] as const, 'resume');
  p.seekShortS = oneOf(p.seekShortS, [5, 10, 15, 20, 30], 10);
  p.seekLongS = oneOf(p.seekLongS, [30, 60, 120, 300, 600], 60);
  p.pauseOnMinimize = p.pauseOnMinimize === true;
  p.inWindowVideo = p.inWindowVideo !== false;
  p.normalize = p.normalize === true;
  p.alwaysForced = p.alwaysForced !== false;
  p.preferSdh = p.preferSdh === true;
  p.audioDescription = oneOf(p.audioDescription, ['prefer', 'avoid', 'any'] as const, 'avoid');
  const types = ['default', 'mpv', 'html'] as const;
  const byType = p.playerByType ?? d.playback.playerByType;
  p.playerByType = {
    movie: oneOf(byType.movie, types, 'default'),
    episode: oneOf(byType.episode, types, 'default'),
    music: oneOf(byType.music, types, 'default'),
    live: oneOf(byType.live, types, 'default'),
  };
  // A device name goes to mpv as one argv entry; it never reaches a shell.
  p.audioDevice = typeof p.audioDevice === 'string' && p.audioDevice.length <= 300 && !/[\r\n\0]/.test(p.audioDevice) && p.audioDevice ? p.audioDevice : 'auto';
  p.mpvArgs = typeof p.mpvArgs === 'string' ? p.mpvArgs.replace(/[\r\n\0]+/g, ' ').slice(0, 2000) : '';
  p.aspect = oneOf(p.aspect, ASPECT_MODES, 'fit');
  p.cinemaMode = p.cinemaMode === true;
  p.aniskip = p.aniskip === true;
  p.communitySegments = p.communitySegments === true;
  const scopes = ['off', 'global', 'library', 'title'] as const;
  const rs = { ...d.playback.rememberScopes, ...(p.rememberScopes ?? {}) };
  p.rememberScopes = {
    speed: oneOf(rs.speed, scopes, 'global'),
    audioDelay: oneOf(rs.audioDelay, scopes, 'title'),
    subtitleDelay: oneOf(rs.subtitleDelay, scopes, 'title'),
    aspect: oneOf(rs.aspect, scopes, 'title'),
  };

  const sys = (s.system = { ...d.system, ...(s.system ?? {}) });
  sys.hardwareAcceleration = sys.hardwareAcceleration !== false;
  sys.comicCacheGb = oneOf(sys.comicCacheGb, [0.5, 1, 2, 5, 10], 2);
  sys.plainTextVault = sys.plainTextVault === true;
}

function sanitizeLive(s: StoredSettings): void {
  const l = (s.live = { ...defaultSettings().live, ...(s.live ?? {}) });
  l.release = oneOf(l.release, ['auto', 'always', 'never'] as const, 'auto');
  l.timeshiftMinutes = oneOf(l.timeshiftMinutes, [0, 15, 30, 60, 120] as const, 15);
  l.reminderLeadMin = oneOf(l.reminderLeadMin, [0, 1, 2, 5, 10] as const, 2);
  l.reminderAutoTune = l.reminderAutoTune === true;
  const now = Date.now();
  const learned: Record<string, { until: number }> = {};
  const src = l.releaseFirst && typeof l.releaseFirst === 'object' && !Array.isArray(l.releaseFirst) ? l.releaseFirst : {};
  for (const [id, v] of Object.entries(src).slice(0, 64)) {
    const until = (v as { until?: unknown })?.until;
    // Expired entries go; a date further than the 7-day memory is not believed.
    if (id.length <= 128 && typeof until === 'number' && until > now && until <= now + 7 * 86_400_000 + 60_000) learned[id] = { until };
  }
  l.releaseFirst = learned;
}

// keep: the values a refused edit falls back to (the current ones on an update, else the defaults).
function sanitize(s: StoredSettings, keep?: StoredSettings): StoredSettings {
  const d = defaultSettings();
  // Builds before the theme list stored Graphite as 'dark'.
  // 'hyprland' (desktop-theme-linux.ts) only exists on Linux; an import from there falls back to Graphite elsewhere.
  s.ui.theme = THEMES.includes(s.ui.theme) && (s.ui.theme !== 'hyprland' || process.platform === 'linux') ? s.ui.theme : 'graphite';
  s.ui.accent = ACCENTS.includes(s.ui.accent) ? s.ui.accent : 'blue';
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 64) : []);
  s.ui.homeRows = (Array.isArray(s.ui.homeRows) ? s.ui.homeRows : [])
    .filter((p) => p && typeof p.user === 'string' && p.user.length <= 160)
    .slice(-16)
    .map((p) => ({ user: p.user, order: ids(p.order), hidden: ids(p.hidden) }));
  s.playback.player = (['auto', 'mpv', 'html'] as const).includes(s.playback.player) ? s.playback.player : 'auto';
  // Only the values this platform's picker offers; an imported value from the other OS goes back to Auto.
  const hwdecs = process.platform === 'win32' ? (['auto-safe', 'd3d11va', 'nvdec', 'no'] as const) : (['auto-safe', 'nvdec', 'vaapi', 'vulkan', 'no'] as const);
  s.playback.hwdec = oneOf<HwDec>(s.playback.hwdec, hwdecs, 'auto-safe');
  // Older builds had "only forced" and "never": both became Manuel, which shows forced tracks only.
  const mode = s.playback.subtitleMode as string;
  s.playback.subtitleMode = (['manual', 'foreign', 'always', 'default'] as const).includes(s.playback.subtitleMode)
    ? s.playback.subtitleMode
    : mode === 'only-forced' || mode === 'none'
      ? 'manual'
      : d.playback.subtitleMode;
  s.playback.maxResolution = [0, 720, 1080, 1440, 2160].includes(s.playback.maxResolution) ? s.playback.maxResolution : 0;
  for (const k of ['forceTranscode', 'volumeBoost', 'nightMode', 'dialogueBoost'] as const) s.playback[k] = s.playback[k] === true;
  const st = s.playback.subtitleStyle;
  const ds = d.playback.subtitleStyle;
  s.playback.subtitleStyle = {
    size: Math.round(clamp(st?.size, 50, 200, ds.size)),
    font: SUBTITLE_FONTS.includes(st?.font as (typeof SUBTITLE_FONTS)[number]) ? st.font : ds.font,
    color: typeof st?.color === 'string' && /^#[0-9a-f]{6}$/i.test(st.color) ? st.color.toUpperCase() : ds.color,
    border: (['outline', 'shadow', 'box'] as const).includes(st?.border) ? st.border : ds.border,
    position: Math.round(clamp(st?.position, 50, 100, ds.position)),
    overrideAss: st?.overrideAss === true,
    scaleWithVideo: st?.scaleWithVideo === true,
  };
  s.playback.hdrAutoSwitch = s.playback.hdrAutoSwitch === true;
  s.playback.skipIntro = (['ask', 'auto', 'off'] as const).includes(s.playback.skipIntro) ? s.playback.skipIntro : 'ask';
  s.playback.spdif = Array.isArray(s.playback.spdif) ? s.playback.spdif.filter((c) => SPDIF_CODECS.has(c)) : [];
  s.playback.maxBitrateMbps = clamp(s.playback.maxBitrateMbps, 1, 400, d.playback.maxBitrateMbps);
  // Wicaby runs this file: an mpv.exe on a local drive (Linux: an absolute .../mpv), or nothing. Existence is checked
  // where it is run (isSafeMpvPath), so a drive that is not mounted yet does not wipe it.
  s.playback.mpvPath = isMpvPathShape(s.playback.mpvPath, process.platform) ? s.playback.mpvPath : '';
  s.playback.preferredAudioLanguage = String(s.playback.preferredAudioLanguage ?? '').slice(0, 8);
  s.playback.preferredSubtitleLanguage = String(s.playback.preferredSubtitleLanguage ?? '').slice(0, 8);
  s.playback.subtitleSearchLanguage = String(s.playback.subtitleSearchLanguage ?? '').slice(0, 8);
  s.downloads.maxConcurrent = Math.round(clamp(s.downloads.maxConcurrent, 1, 6, d.downloads.maxConcurrent));
  // Downloads must land on a local absolute folder: a UNC or drive-relative path would let a
  // compromised renderer send files (and NTLM credentials) to a remote share.
  s.downloads.folder = isLocalAbsoluteFolder(s.downloads.folder) ? s.downloads.folder : d.downloads.folder;
  sanitizeExtras(s, d);
  sanitizeLive(s);
  s.windows = { ...d.windows, ...(s.windows ?? {}) };
  for (const k of ['closeToTray', 'launchAtStartup', 'trayHintShown'] as const) s.windows[k] = s.windows[k] === true;
  for (const k of ['notifyDownloads', 'notifyNewEpisodes', 'notifyAdmin'] as const) s.windows[k] = s.windows[k] !== false;
  const t = (s.torrents = { ...d.torrents, ...(s.torrents ?? {}) });
  t.url = typeof t.url === 'string' && t.url.length <= 512 && /^https?:\/\/[^\s/]+/i.test(t.url) ? t.url.replace(/\/+$/, '') : '';
  t.username = typeof t.username === 'string' ? t.username.slice(0, 256) : '';
  for (const k of ['notifyOnComplete', 'scanOnComplete', 'magnetHandler'] as const) t[k] = typeof t[k] === 'boolean' ? t[k] : d.torrents[k];
  const short = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  t.libraryMap = (Array.isArray(t.libraryMap) ? t.libraryMap : [])
    .filter((l) => l && short(l.category, 200) && short(l.serverId, 128) && short(l.libraryId, 128) && short(l.libraryName, 200))
    .slice(0, 64)
    .map(({ category, serverId, libraryId, libraryName }) => ({ category, serverId, libraryId, libraryName }));
  // Window placement goes to screen APIs on the next start: only finite numbers are kept.
  const w = (s.window ?? {}) as Settings['window'];
  const nums = <K extends string>(o: unknown, keys: readonly K[]): Record<K, number> | undefined =>
    o && typeof o === 'object' && keys.every((k) => Number.isFinite((o as Record<string, unknown>)[k]))
      ? (Object.fromEntries(keys.map((k) => [k, (o as Record<string, number>)[k]])) as Record<K, number>)
      : undefined;
  const bounds = nums(w.bounds, ['x', 'y', 'width', 'height'] as const);
  const mini = nums(w.mini, ['x', 'y'] as const);
  s.window = { ...(bounds ? { bounds } : {}), ...(typeof w.maximized === 'boolean' ? { maximized: w.maximized } : {}), ...(mini ? { mini } : {}) };
  s.trakt = { offServers: ids(s.trakt?.offServers) };
  s.remote = { allowControl: s.remote?.allowControl !== false };
  // Files from before 0.10.6 have no section: merge() fills the default (on).
  s.updates = { autoCheck: s.updates?.autoCheck !== false };
  s.cast = { discovery: s.cast?.discovery !== false, relay: s.cast?.relay !== false, allowHevc: s.cast?.allowHevc === true, dolby: s.cast?.dolby === true };
  const m = s.photos?.map;
  s.photos = {
    map: {
      enabled: m?.enabled === true,
      // A mistyped edit keeps the server in use rather than switching to tile.openstreetmap.org.
      tileUrl: isTileTemplate(m?.tileUrl) ? m.tileUrl : (keep?.photos?.map?.tileUrl ?? OSM_TILES),
      attribution: typeof m?.attribution === 'string' && m.attribution.trim() && m.attribution.length <= 200 ? m.attribution.trim() : d.photos.map.attribution,
    },
  };
  const mu = { ...d.music, ...(s.music ?? {}) };
  s.music = {
    replayGain: oneOf(mu.replayGain, ['off', 'track', 'album', 'auto'] as const, 'album'),
    preampDb: Math.round(clamp(mu.preampDb, -15, 15, 0) * 2) / 2,
    fallbackDb: Math.round(clamp(mu.fallbackDb, -15, 0, d.music.fallbackDb) * 2) / 2,
    preventClipping: mu.preventClipping !== false,
    gapless: mu.gapless !== false,
    resumeQueue: mu.resumeQueue !== false,
    lyricsProvider: oneOf(mu.lyricsProvider, ['server', 'server+lrclib'] as const, 'server'),
    eq: sanitizeEq(mu.eq),
    source: typeof mu.source === 'string' && mu.source.length <= 128 ? mu.source : '',
  };
  return s;
}

export function isLocalAbsoluteFolder(p: unknown, platform: string = process.platform): p is string {
  if (typeof p !== 'string' || !p || p.length > 260 || /[\u0000-\u001f?*"<>|]/.test(p)) return false;
  // Drive-absolute only (D:\Media or D:/Media): UNC (\\server\share, \\?\, //host) is refused, see the call site.
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return path.posix.isAbsolute(p);
}
