// Contract shared by the main process, the preload bridge and the renderer.
// Everything that crosses the IPC boundary is declared here, so both sides
// fail to compile when they drift apart (Emby used an untyped string frame).
import type { AppUpdate } from './app-update';
import type { LensRef, ZapEntry } from './livetv/model';
import type { Lyrics } from './music';
import type { QualityRow } from './quality-presets';
import type { ExternalRating } from './ratings';
import type { SongMatch } from './song-id';

export type { LensRef, ZapEntry } from './livetv/model';

// 'files': a local folder, WebDAV folder or SMB share (file-sources-spec, main/files).
// 'plex': a Plex Media Server through the Plex dialect (plex-spec §3; shared/plex). Its server id is 40 hex.
// 'navidrome': an OpenSubsonic music server (Navidrome, gonic…) through the Subsonic dialect (shared/subsonic).
// 'iptv': a client-side IPTV source (an M3U playlist and an XMLTV guide, main/iptv) answering the Emby Live TV calls.
export type ServerKind = 'emby' | 'jellyfin' | 'files' | 'plex' | 'iptv' | 'navidrome';

export interface ServerInfo {
  id: string;
  name: string;
  kind: ServerKind;
  version: string;
  manualAddress?: string;
  localAddress?: string;
  remoteAddress?: string;
  lastAddress?: string;
  lastConnected?: number;
  userId?: string;
  userName?: string;
  hasToken: boolean;
  // Overlay network the server lives on, when one of its addresses is a VPN address.
  vpn?: VpnKind;
  // File sources only: the protocol (icon) and the address as shown, never with credentials.
  // photos: a photo source (Settings > Photo sources), its own photo library instead of a Files entry.
  files?: { protocol: FileProtocol; display: string; photos?: boolean };
  // Plex servers (plex-spec §5.6): the linked plex.tv account that lists it, owned or shared by `source`, and
  // whether the user hid it (D-10: shared servers show by default).
  plex?: { account: string; owned: boolean; source?: string; hidden?: boolean };
}

// A plex.tv account linked with a code (plex-spec §5.1).
export interface PlexAccount {
  id: string;
  name: string;
  // Plex Pass on this account (plex.tv subscription): what gated features to explain (plex-spec §1.3).
  pass?: boolean;
  // The account's subtitle mode and language (plex.tv /api/v2/user profile), the default of a Plex play (§6.4, #1182).
  subtitles?: { mode?: SubtitleMode; language: string };
}

export interface PlexLinkPin {
  code: string;
  // https://plex.tv/link?code=…, shown as a QR code.
  url: string;
  expiresIn: number;
}

export type PlexLinkPoll = { status: 'waiting' } | { status: 'expired' } | { status: 'linked'; servers: ServerInfo[] };

export interface DiscoveredServer {
  id: string;
  name: string;
  address: string;
  kind: ServerKind;
}

export interface PublicUser {
  id: string;
  name: string;
  hasPassword: boolean;
  imageTag?: string;
}

export type SessionStatus = 'no-server' | 'connecting' | 'server-selected' | 'signed-in' | 'offline';

export interface SessionUser {
  id: string;
  name: string;
  isAdmin: boolean;
  imageTag?: string;
}

// One signed-in (or signing-in) server. Several can be up at once.
export interface ServerSession {
  status: Exclude<SessionStatus, 'no-server'>;
  server: ServerInfo;
  user?: SessionUser;
  address?: string;
  // Realtime socket of a signed-in server (absent without one), and how address is reached.
  socket?: 'connecting' | 'open' | 'down';
  // relay: a Plex relay connection (bandwidth-capped by Plex).
  route?: 'local' | 'remote' | 'mesh' | 'relay';
  // Plex (D-3): the server answered only at this plain-http LAN address, which gets the token once the user agrees.
  confirm?: string;
}

// status/server/user/address describe the primary server (single-server UI bits);
// status is 'signed-in' as soon as any session is. sessions lists every server, primary first.
export interface SessionState {
  status: SessionStatus;
  server?: ServerInfo;
  user?: SessionUser;
  address?: string;
  sessions: ServerSession[];
}

export type PlayerChoice = 'auto' | 'mpv' | 'html';
// d3d11va is Windows-only, vaapi and vulkan Linux-only (mpv-args.ts mpvOutputArgs maps the others).
export type HwDec = 'auto-safe' | 'd3d11va' | 'nvdec' | 'vaapi' | 'vulkan' | 'no';
// Plex-like auto-selection. manual: forced tracks only; foreign: full subtitles when the
// audio is not in the subtitle language; always; default: the file/server default flag.
export type SubtitleMode = 'manual' | 'foreign' | 'always' | 'default';
export type AudioDescriptionPref = 'prefer' | 'avoid' | 'any';

export const SUBTITLE_FONTS = ['Geist', 'Segoe UI', 'Arial', 'Verdana', 'Georgia'] as const;

// Text subtitle look in mpv (SRT, WebVTT; ASS only when overrideAss is on).
export interface SubtitleStyle {
  // Percent of mpv's default size.
  size: number;
  font: string;
  // #RRGGBB
  color: string;
  border: 'outline' | 'shadow' | 'box';
  // mpv sub-pos: 100 = bottom edge, lower values move the text up.
  position: number;
  overrideAss: boolean;
  // Size follows the video picture (mpv sub-scale-with-window=no) instead of the window.
  scaleWithVideo: boolean;
}

// Player for one content type; 'default' follows playback.player.
export type TypePlayer = 'default' | 'mpv' | 'html';
export type ResumeMode = 'ask' | 'resume' | 'start';
// X-05 "Mémoriser les réglages": where each player setting is remembered.
export type RememberScope = 'off' | 'global' | 'library' | 'title';
export interface RememberScopes {
  speed: RememberScope;
  audioDelay: RememberScope;
  subtitleDelay: RememberScope;
  aspect: RememberScope;
}

// Picture format: letterbox, crop to fill, stretch, zoom (with a factor), or 1:1 pixels.
export type AspectMode = 'fit' | 'fill' | 'stretch' | 'zoom' | 'original';
export const ASPECT_MODES: AspectMode[] = ['fit', 'fill', 'stretch', 'zoom', 'original'];
export const ZOOM_STEPS = [1.1, 1.25, 1.5, 2];
export interface VideoAspect {
  mode: AspectMode;
  // Only used in 'zoom' mode; one of ZOOM_STEPS.
  zoom: number;
}
export const LIBRARY_SORTS = ['SortName', 'DateCreated', 'ProductionYear', 'CommunityRating', 'PremiereDate'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const ACCENTS = ['blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'green', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];
// Theme ids shared with the Android apps (packages/tokens/tokens.json); 'system' follows Windows between light and graphite.
// After it, desktop-only ids: 'hyprland' paints with the Hyprland / Omarchy colours (main/features/desktop-theme-linux.ts).
export const THEMES = ['graphite', 'oled', 'slate', 'cinema', 'contrast', 'light', 'system', 'hyprland'] as const;
export type Theme = (typeof THEMES)[number];

// The 'hyprland' theme's colours: every tokens.css custom property (--bg, --label-2, --accent...), computed in main.
export interface DesktopPalette {
  // omarchy: the current theme's colors.toml; hyprland: only the active border colour, over Graphite.
  source: 'omarchy' | 'hyprland';
  // The Omarchy theme name (theme.name), when there is one.
  name?: string;
  mode: 'dark' | 'light';
  tokens: Record<string, string>;
}
// available: false on Windows and on Linux without Omarchy or Hyprland (the theme card is hidden then).
export interface DesktopThemeState {
  available: boolean;
  palette: DesktopPalette | null;
}

// Home layout for one user (`serverId/userId`): row ids in display order, and
// the hidden ones. Rows the list does not know yet keep their default place.
export interface HomeRowsPref {
  user: string;
  order: string[];
  hidden: string[];
}

export interface Settings {
  ui: {
    theme: Theme;
    accent: Accent;
    reduceMotion: boolean;
    reduceTransparency: boolean;
    sidebarCollapsed: boolean;
    // Sidebar groups the user hid (renderer/lib/sidebar-groups.ts GROUPS ids), from Settings > Home and libraries.
    sidebarHidden: string[];
    homeRows: HomeRowsPref[];
    // 'home', 'favorites' or 'library:<id>'.
    startPage: string;
    confirmQuitDuringPlayback: boolean;
    density: 'comfortable' | 'compact';
    // Card width, percent of the default (80–130).
    posterSize: number;
    cardRatings: boolean;
    cardAges: boolean;
    cardQuality: boolean;
    cardTitles: boolean;
    heroEnabled: boolean;
    heroAutoplay: boolean;
    // webContents zoom factor in percent (90–125).
    zoom: number;
    libraryView: 'poster' | 'thumb';
    librarySort: LibrarySort;
    librarySortDesc: boolean;
    fpsMeter: boolean;
    // 'auto' follows the Windows language: French for fr-*, English otherwise.
    language: 'auto' | 'fr' | 'en';
    // X-01: one "Continuer à regarder" row instead of "Continuer" + "À suivre", and the cards removed from it
    // (`serverId:userId:itemId` → the card's date then; renderer/lib/continue.ts).
    mergeContinue: boolean;
    continueHidden: { key: string; played: string }[];
    // X-04: rebound player shortcuts (shared/shortcuts.ts), action id -> combos, null = disabled.
    shortcuts: Record<string, string[] | null>;
    // First-run setup (/welcome) done or skipped. Files written before it existed count as done.
    onboarded: boolean;
    // File sources join Home's Continue row (file-sources-spec D10); their own page always has one.
    filesOnHome: boolean;
  };
  playback: {
    player: PlayerChoice;
    mpvPath: string;
    useMpvConfig: boolean;
    hwdec: HwDec;
    hdrPassthrough: boolean;
    hdrAutoSwitch: boolean;
    matchRefreshRate: boolean;
    // mpv --video-sync=display-resample: frames follow the display's clock, the audio is resampled to match.
    smoothMotion: boolean;
    audioExclusive: boolean;
    // Codecs sent as bitstream (mpv --audio-spdif); WASAPI then runs exclusive for them.
    spdif: string[];
    maxBitrateMbps: number;
    // Height cap in pixels, 0 = none; larger videos are transcoded down.
    maxResolution: number;
    forceTranscode: boolean;
    // mpv volume-max 150 instead of 100.
    volumeBoost: boolean;
    nightMode: boolean;
    dialogueBoost: boolean;
    subtitleStyle: SubtitleStyle;
    preferredAudioLanguage: string;
    preferredSubtitleLanguage: string;
    // X-03: the language last searched in the player's subtitle search ('' = none yet).
    subtitleSearchLanguage: string;
    subtitleMode: SubtitleMode;
    autoPlayNext: boolean;
    startFullscreen: boolean;
    // Linux, native Wayland: libmpv draws inside the player window (texture mode); off keeps mpv's own window.
    inWindowVideo: boolean;
    // Used when the server has no per-user preference (Jellyfin, older Emby).
    skipIntro: SkipMode;
    skipCredits: SkipMode;
    // Recaps, previews and commercials (Jellyfin MediaSegments, Emby markers when the server has them).
    skipRecap: SkipMode;
    skipPreview: SkipMode;
    skipCommercial: SkipMode;
    // Anime intro/credits from api.aniskip.com when the server has none (third party: off by default).
    aniskip: boolean;
    // Intro, recap, credits and preview from TheIntroDB and IntroDB when the server has none (third parties: off by default).
    communitySegments: boolean;
    // maxBitrateMbps applies on the LAN, this one when the server address is remote.
    maxBitrateRemoteMbps: number;
    defaultSpeed: number;
    upNextSeconds: number;
    resume: ResumeMode;
    seekShortS: number;
    seekLongS: number;
    pauseOnMinimize: boolean;
    playerByType: { movie: TypePlayer; episode: TypePlayer; music: TypePlayer; live: TypePlayer };
    // mpv --audio-device name ('auto' = Windows default output).
    audioDevice: string;
    normalize: boolean;
    alwaysForced: boolean;
    // Accessibility: SDH subtitles first, and whether an audio-description track may be picked automatically.
    preferSdh: boolean;
    audioDescription: AudioDescriptionPref;
    // Extra mpv command-line options, space separated (--wid and the IPC options are refused).
    mpvArgs: string;
    // Picture format every item starts in; a choice in the player lasts for that item until restart.
    aspect: AspectMode;
    // Plays one or two local trailers before a film (server intros, else unwatched similar films).
    cinemaMode: boolean;
    // X-05: scope per player setting (main/playback/scoped-prefs.ts).
    rememberScopes: RememberScopes;
  };
  system: {
    // Read at startup only: false drops the GPU switches and disables Chromium's GPU use.
    hardwareAcceleration: boolean;
    comicCacheGb: number;
    // Linux without a keyring: the user accepted keeping sign-ins on disk unencrypted (vault.ts).
    plainTextVault: boolean;
  };
  downloads: {
    folder: string;
    maxConcurrent: number;
  };
  // qBittorrent Web UI. The password lives in the vault, never here.
  torrents: {
    // '' = not configured (no polling at all).
    url: string;
    username: string;
    notifyOnComplete: boolean;
    scanOnComplete: boolean;
    magnetHandler: boolean;
    libraryMap: TorrentLibraryLink[];
  };
  // Trakt scrobbling. The client secret and the tokens live in the vault, never here.
  trakt: {
    // Servers whose plays Wicaby does not scrobble (the user's choice, e.g. the server has the Trakt plugin).
    offServers: string[];
  };
  window: {
    bounds?: { x: number; y: number; width: number; height: number };
    maximized?: boolean;
    // Music mini player (music-spec MU-10): where it was last left.
    mini?: { x: number; y: number };
  };
  // Windows integration (features/tray.ts, startup.ts, notify.ts).
  windows: {
    // Closing the main window hides it in the notification area; playback goes on.
    closeToTray: boolean;
    // Mirrors the HKCU Run entry (Linux: ~/.config/autostart/com.wika.wicaby.desktop); Wicaby then starts hidden (--hidden).
    launchAtStartup: boolean;
    // The one-time "Wicaby is still running" notification was shown.
    trayHintShown: boolean;
    notifyDownloads: boolean;
    // New episodes of series in progress (resume or next up), from LibraryChanged.
    notifyNewEpisodes: boolean;
    // Administrators: failed scheduled task, restart required, server update (polled).
    notifyAdmin: boolean;
  };
  // Being controlled from other apps of the account (cast-spec CA-02): off posts SupportsMediaControl:false
  // and drops every remote Play, Playstate and GeneralCommand.
  remote: {
    allowControl: boolean;
  };
  // Direct casting (cast-spec CA-07): SSDP while the picker is open; the LAN relay keeps the token off the TV.
  cast: {
    discovery: boolean;
    relay: boolean;
    // Chromecast (CA-09, castProfile): HEVC on any model, AC3/EAC3 passed through.
    allowHevc: boolean;
    dolby: boolean;
  };
  // Desktop update notice (features/app-updates.ts): the GitHub release check at start and every 24 h.
  updates: {
    autoCheck: boolean;
  };
  // Live TV (§15): the keys the renderer shows; the rest of main's LiveSettings (core/settings.ts) stays main-side.
  live: {
    reminderLeadMin: 0 | 1 | 2 | 5 | 10;
    reminderAutoTune: boolean;
  };
  // Photos map (photos spec PH-09, §6.1): off by default, since tile requests show the provider where the photos were
  // taken. tileUrl: an http(s) template with {z}, {x} and {y}, fetched by main only (main/photos/tiles.ts).
  photos: {
    map: { enabled: boolean; tileUrl: string; attribution: string };
  };
  // Music (music-spec §4.1, D2): ReplayGain album by default; 'auto' = album while an album plays in order.
  music: {
    replayGain: 'off' | 'track' | 'album' | 'auto';
    // -15…+15 dB on top of the gain.
    preampDb: number;
    // Gain for a file without tags or server value (modern loud masters).
    fallbackDb: number;
    preventClipping: boolean;
    gapless: boolean;
    // D8: the queue comes back, paused, at start-up.
    resumeQueue: boolean;
    // MU-13: 'server+lrclib' asks lrclib.net (main/music/lrclib.ts) when the server has no lyrics. Off by default.
    lyricsProvider: 'server' | 'server+lrclib';
    // MU-11: the mpv player's equalizer (shared/equalizer.ts); flat = no filter.
    eq: { bands: number[]; preampDb: number };
    // "Source de la musique" (shared/music-source.ts): the server id whose music libraries Music shows; '' = all.
    source: string;
  };
}

export interface AudioDevice {
  name: string;
  description: string;
}

export interface StorageUsage {
  http: number;
  comics: number;
  logs: number;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chromium: string;
  node: string;
  platform: string;
  osRelease: string;
  deviceId: string;
  deviceName: string;
  mpvPath: string | null;
  mpvVersion: string | null;
  userDataPath: string;
  logPath: string;
  isPackaged: boolean;
  // Linux without a keyring (safeStorage basic_text): sign-ins are not really encrypted.
  vaultPlainText: boolean;
  // Refresh-rate matching can switch this session's displays (display-mode.ts available()).
  refreshRateMatch: boolean;
}

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

// ---- Playback ----

export interface Track {
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  // Hearing-impaired subtitles / audio description (shared/track-selection.ts isSdh, isAd).
  sdh?: boolean;
  ad?: boolean;
}

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface NowPlayingItem {
  id: string;
  serverId?: string;
  name: string;
  type: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  imageItemId?: string;
  imageTag?: string;
  backdropItemId?: string;
  backdropTag?: string;
  // Real chapters only (Emby intro/credits markers are moved to PlaybackState.markers).
  // index addresses /Items/{id}/Images/Chapter/{index}.
  chapters: { name: string; startMs: number; index: number; imageTag?: string }[];
  // Audio only (music-spec MU-02): the album (its Primary image is the art), the track artists and the album artist.
  album?: string;
  albumId?: string;
  artists?: string[];
  albumArtist?: string;
  indexNumber?: number;
}

// Music (music-spec §4.1): set while the current item is a track. The renderer fetches names and art by id.
export interface MusicState {
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  queue: { ids: string[]; index: number };
  // Instant-mix top-up when the queue runs out.
  radio: boolean;
  // Where the loudness gain comes from: the file's ReplayGain tags, the server (Jellyfin NormalizationGain) or the fallback.
  gain?: { source: 'tags' | 'server' | 'none'; db: number };
  lyrics?: { kind: 'synced' | 'plain'; source: 'server' | 'lrclib' };
}

// What lrclib.net is asked for (MU-13): the track id keys the cache, the rest is the query.
export interface LrclibTrack {
  id: string;
  artist: string;
  title: string;
  album: string;
  durationMs: number;
}

// "What's this song?" (main/playback/song-id.ts). unavailable: no mpv, or too little of the stream cached yet.
export type SongIdResult = { song: SongMatch } | { error: 'unavailable' | 'nomatch' | 'rateLimited' | 'failed' };

export type SkipMode = 'ask' | 'auto' | 'off';
export type SkipSegmentType = 'recap' | 'preview' | 'commercial';
export interface SkipSegment {
  type: SkipSegmentType;
  startMs: number;
  endMs: number;
}

// Intro range and credits start, from Emby chapter markers or Jellyfin MediaSegments; segments are
// the other skippable ranges (Settings > Playback has one Ask / Auto / Off setting per type).
export interface MediaMarkers {
  introStartMs?: number;
  introEndMs?: number;
  creditsStartMs?: number;
  segments?: SkipSegment[];
}

// Next-episode card. deadline (epoch ms) is set while the countdown runs;
// leftMs is the frozen remainder while paused. stillWatching replaces the countdown.
export interface UpNext {
  id: string;
  name: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  imageItemId?: string;
  imageTag?: string;
  countdownMs: number;
  auto: boolean;
  deadline?: number;
  leftMs: number;
  stillWatching?: boolean;
}

// Scrub thumbnails: an Emby BIF file, or Jellyfin tile sheets (url has {n} for the sheet index).
export type Trickplay =
  | { kind: 'bif'; url: string }
  | { kind: 'tiles'; url: string; width: number; height: number; tileWidth: number; tileHeight: number; intervalMs: number; count: number };

export interface PlaybackStats {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  frameRate?: number;
  hdr?: string;
  // How mpv outputs an HDR source; the OSD names it in the UI language.
  hdrOutput?: 'passthrough' | 'hdr' | 'sdr';
  // Audio sent as a bitstream through exclusive WASAPI.
  audioBitstream?: boolean;
  bitrateKbps?: number;
  hwdec?: string;
  droppedFrames?: number;
  displayFps?: number;
}

export interface PlaybackState {
  active: boolean;
  player?: 'mpv' | 'html';
  item?: NowPlayingItem;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  buffering: boolean;
  volume: number;
  muted: boolean;
  rate: number;
  audioTracks: Track[];
  subtitleTracks: Track[];
  audioIndex: number | null;
  subtitleIndex: number | null;
  // X-05 (mpv): the subtitle drawn at the top of the picture as well.
  secondarySubtitleIndex?: number | null;
  playMethod?: PlayMethod;
  queueIndex: number;
  queueLength: number;
  fullscreen: boolean;
  offline: boolean;
  stats: PlaybackStats;
  error?: string;
  markers?: MediaMarkers;
  skipMode?: SkipMode;
  creditsSkipMode?: SkipMode;
  upNext?: UpNext;
  trickplay?: Trickplay;
  // Brief OSD readout (delay change, automatic intro skip). The OSD shows it for 2 s after `at`.
  // key is a catalogue key (player.notice.*) the renderer translates, so it follows the UI language.
  notice?: { key: string; params?: Record<string, string | number>; at: number };
  aspect?: VideoAspect;
  // The current item is a trailer (local trailer button, item page extras, cinema mode): nothing is reported to the server.
  trailer?: boolean;
  // Live TV player mode (livetv-spec-final.md §14): set while a channel plays.
  live?: LiveState;
  // Music (music-spec MU-02): set while a track plays.
  music?: MusicState;
  // X-04 sleep timer: 'eov' = end of this video (of this programme in live). endsAt is unset for
  // 'eov' in VOD; promptUntil is the "Still watching?" deadline once it fired.
  sleep?: { minutes: number | 'eov'; endsAt?: number; promptUntil?: number };
  // X-02 quality sheet (shared/quality-presets.ts): versions only when there are 2 or more, rows
  // Original first. currentQuality.maxBitrate null = Original; switching = a reload is in flight.
  qualityOptions?: { versions: { id: string; label: string; size?: number }[]; rows: QualityRow[] };
  currentQuality?: { mediaSourceId?: string; maxBitrate: number | null; switching?: boolean };
  // Leaving the player (X, Escape, Back, stop; never Up Next or auto-advance), unset with reduced motion:
  // 'out' fades the controls and the picture, 'reveal' uncovers the page underneath (mpv).
  exiting?: 'out' | 'reveal';
  // The stream dropped and is being reopened at its position (main/playback/stream-recovery.ts);
  // retry: a minute has passed, the OSD offers Retry ('reconnect-retry').
  reconnecting?: { since: number; retry: boolean };
}

// Live TV (livetv-spec-final.md §14, additive).
export interface LiveNowNext {
  id: string;
  title: string;
  start: number;
  end: number;
  episodeTitle?: string;
  flags: number;
}

export interface LiveState {
  channel: ZapEntry & { serverId: string };
  index: number; // 1-based position in the zap list, 0 when the channel is not in it
  count: number;
  lensLabel: string;
  lens?: LensRef;
  pending?: ZapEntry; // merged zap target (or the tune in flight), shown before the stream is there
  tuning: boolean;
  now?: LiveNowNext; // filled by main after adoption, refreshed at programme boundaries
  next?: LiveNowNext;
  recording?: boolean;
  lastChannelId?: string;
  // windowMs: the window setting after the memory cap; limited: why it is shorter than asked (§8.8).
  timeshift?: { startWall: number; endWall: number; posWall: number; atEdge: boolean; windowMs: number; limited?: 'memory' | 'space' };
  pausedReleased?: boolean;
  startOverItemId?: string;
  policy: 'mbb' | 'bbm';
  radio?: boolean; // no video stream: the OSD shows the radio screen (F6)
}

export interface PlayRequest {
  itemIds: string[];
  // Server the ids belong to; the primary one when absent.
  serverId?: string;
  startIndex?: number;
  startPositionTicks?: number;
  mediaSourceId?: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  player?: 'mpv' | 'html';
  // Trailers: played without resume, progress or watched reports.
  trailer?: boolean;
  // Play next / add to queue (the server's PlayCommand): joins the queue playing, if any.
  command?: 'PlayNext' | 'PlayLast';
  // TvChannel starts only: the lens snapshot that becomes the zap list.
  live?: { lens: LensRef; lensLabel: string; entries: ZapEntry[]; reason?: string };
}

export type PlaybackCommand =
  | { type: 'toggle-pause' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'seek'; positionMs: number }
  | { type: 'seek-relative'; deltaMs: number }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'volume'; value: number }
  | { type: 'mute'; value: boolean }
  | { type: 'audio'; index: number }
  | { type: 'subtitle'; index: number }
  // hold: the OSD's hold-for-2x and its release; the speed memory is left alone.
  | { type: 'rate'; value: number; hold?: boolean }
  | { type: 'toggle-fullscreen' }
  | { type: 'skip'; segment: 'intro' | 'credits' | SkipSegmentType }
  | { type: 'up-next-cancel' }
  // Nudge the audio or subtitle delay by deltaMs (±100 ms steps); 0 resets it. mpv only.
  | { type: 'audio-delay'; deltaMs: number }
  | { type: 'subtitle-delay'; deltaMs: number }
  | { type: 'aspect'; mode: AspectMode; zoom?: number }
  // Live TV (§14). In live mode main maps next / previous to zap.
  | { type: 'zap'; delta: 1 | -1 }
  | { type: 'tune'; channelId: string; reason: 'digits' | 'miniguide' | 'guide' | 'search' | 'last' | 'reminder' }
  | { type: 'last-channel' }
  | { type: 'live-edge' }
  | { type: 'live-lens'; lens: LensRef; lensLabel: string; entries: ZapEntry[] }
  | { type: 'guide-overlay'; open: boolean }
  // Picture-in-picture (LT-23): the player windows become an always-on-top mini window, or back.
  | { type: 'pip' }
  // X-04: start (minutes or end of video), restart ("Continue") or cancel (null) the sleep timer.
  | { type: 'sleep'; minutes: number | 'eov' | null }
  // X-04: mpv sub-seek (Ctrl+←/→): the previous or next subtitle line.
  | { type: 'sub-seek'; delta: 1 | -1 }
  // X-02: reload in place with a bitrate cap (null = Original) and, for VOD, another version.
  | { type: 'quality'; maxBitrate: number | null; mediaSourceId?: string }
  // X-03: after a subtitle download, PlaybackInfo again and select the new external stream.
  | { type: 'subtitles-refresh'; selectNew: true }
  // X-05: a second subtitle at the top of the picture (mpv secondary-sid), null = none.
  | { type: 'secondary-subtitle'; index: number | null }
  // X-05 Réglages "Effacer les réglages mémorisés": speed, delays and aspect.
  | { type: 'forget-player-settings' }
  // The OSD's Retry while reconnecting: an attempt now.
  | { type: 'reconnect-retry' }
  // Music queue (music-spec §4.1): indexes in MusicState.queue.ids.
  | { type: 'queue-move'; from: number; to: number }
  | { type: 'queue-remove'; index: number }
  | { type: 'queue-jump'; index: number }
  | { type: 'queue-clear-upcoming' }
  | { type: 'shuffle'; value: boolean }
  | { type: 'repeat'; mode: 'off' | 'all' | 'one' }
  | { type: 'radio'; value: boolean };

// Live TV reminders (§9.6, LT-19), kept on this device per server and user.
export interface LiveReminder {
  serverId: string;
  programId: string;
  channelId: string;
  start: number; // epoch ms
  title: string;
  channelName: string;
  skewMs?: number; // server clock − client clock when set (§21.4): `start` is a server time
}

// The auto-tune countdown of a reminder while a channel plays (§9.6): tunes at `at` unless "Rester ici".
export interface ReminderCountdown {
  title: string;
  channelName: string;
  at: number;
}

// Main asks the renderer-hosted <video> element to do something.
export interface HtmlPlayerLoad {
  url: string;
  isHls: boolean;
  startMs: number;
  volume: number;
  muted: boolean;
  subtitles: { index: number; url: string; label: string; language?: string }[];
  subtitleIndex: number | null;
  rate?: number;
  // Music (music-spec §4.1.2): an <audio> element in the main window, not the player route; gainDb through a GainNode.
  audio?: { gainDb: number; paused: boolean };
}

export type HtmlPlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'volume'; value: number }
  | { type: 'mute'; value: boolean }
  | { type: 'rate'; value: number }
  | { type: 'subtitle'; index: number | null }
  | { type: 'unload' };

export type HtmlPlayerEvent =
  | { type: 'time'; positionMs: number; durationMs: number; paused: boolean; buffering: boolean }
  | { type: 'volume'; volume: number; muted: boolean }
  | { type: 'stats'; stats: PlaybackStats }
  | { type: 'ended' }
  | { type: 'error'; message: string };

// ---- Downloads ----

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error';

export interface DownloadEntry {
  id: string;
  serverId: string;
  itemId: string;
  name: string;
  type: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runTimeTicks?: number;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  filePath?: string;
  posterPath?: string;
  error?: string;
  addedAt: number;
  completedAt?: number;
}

// ---- Comics ----

// Dimensions are 0 when the header could not be read; the reader measures on decode.
export interface ComicPage {
  width: number;
  height: number;
  double?: boolean;
}

export interface ComicInfo {
  pageCount: number;
  title: string;
  startPage: number;
  pages: ComicPage[];
  // From ComicInfo.xml: manga = right-to-left, webtoon = Format "Web".
  meta: { title?: string; series?: string; number?: string; manga?: boolean; webtoon?: boolean };
}

// Book progress rides on PlaybackPositionTicks with the page as "milliseconds",
// like Jellyfin's comic reader; small raw values from other clients are pages.
export const comicPageFromTicks = (ticks: number | undefined): number =>
  !ticks || ticks < 0 ? 0 : ticks >= 10_000 ? Math.round(ticks / 10_000) : Math.round(ticks);

// ---- VPN (installed Tailscale / NetBird clients, embedded tailnet node) ----

export type VpnKind = 'tailscale' | 'netbird' | 'embedded';
export type VpnState = 'not-installed' | 'stopped' | 'needs-login' | 'connecting' | 'connected' | 'error';
// The mesh an embedded node joins (installed clients are their own kind).
export type MeshProvider = 'tailscale' | 'netbird';

export interface VpnConnectOptions {
  // Embedded node only: which mesh to sign in to.
  provider?: MeshProvider;
  // NetBird self-hosted management server (https://…); Headscale for Tailscale. '' = the hosted service.
  managementUrl?: string;
  // Tailscale auth key (tskey-…) or NetBird setup key; skips the browser login.
  authKey?: string;
}

export interface VpnStatus {
  kind: VpnKind;
  state: VpnState;
  // Embedded node: the mesh it is on (or signing in to).
  provider?: MeshProvider;
  // This device on the overlay network.
  selfName?: string;
  selfDnsName?: string;
  ips: string[];
  // MagicDNS / NetBird domain suffix, without leading dot.
  dnsSuffix?: string;
  // Embedded node: the management server it uses (absent = the provider's hosted service).
  managementUrl?: string;
  // Pending interactive login (Tailscale AuthURL, NetBird SSO link).
  authUrl?: string;
  downloadUrl?: string;
  error?: string;
  // Embedded NetBird node: CIDRs routed through a peer (network routes).
  routes?: string[];
  // Embedded node: the last error it reported this run (kept in memory only).
  lastError?: { message: string; at: number };
}

export interface VpnPeer {
  kind: VpnKind;
  name: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
  os?: string;
  // Emby/Jellyfin servers that answered on 8096/8920 (filled by vpn.peers()).
  servers: { address: string; name: string; kind: ServerKind; id: string }[];
}

export interface VpnConnectResult {
  status: VpnStatus;
  // Set when the client asked for an interactive login; main already opened it.
  authUrl?: string;
}

// ---- Torrents (qBittorrent Web API v2) ----

// A qBittorrent category feeding a media-server library (library ids are per server).
export interface TorrentLibraryLink {
  category: string;
  serverId: string;
  libraryId: string;
  libraryName: string;
}

export interface Torrent {
  hash: string;
  name: string;
  // Raw qBittorrent state (downloading, stalledDL, stoppedUP, pausedDL…).
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  // Seconds; 8640000 = infinite.
  eta: number;
  size: number;
  ratio: number;
  category: string;
  seeds: number;
  seedsTotal: number;
  peers: number;
  peersTotal: number;
  addedOn: number;
  savePath: string;
  sequential: boolean;
  firstLast: boolean;
  forceStart: boolean;
  // Queue position, 0 / -1 when queueing is off or the torrent is seeding.
  priority: number;
  // Set once the finished torrent was found in the mapped library.
  available?: { libraryName: string; itemId: string; serverId: string };
}

export type TorrentsStatus = 'unconfigured' | 'connecting' | 'online' | 'offline' | 'auth' | 'certificate';

export interface TorrentCertificate {
  host: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  error: string;
}

export interface TorrentsState {
  status: TorrentsStatus;
  error?: string;
  version?: string;
  apiVersion?: string;
  certificate?: TorrentCertificate;
  torrents: Torrent[];
  categories: { name: string; savePath: string }[];
  transfer: { dlSpeed: number; upSpeed: number; altSpeed: boolean; freeSpace?: number };
}

export interface TorrentConfig {
  url: string;
  username: string;
  // undefined keeps the stored password.
  password?: string;
}

// How a LAN service (qBittorrent, WebDAV) was reached: directly, or through the built-in mesh node's forwarder.
// 'outside' = the host is no mesh peer and in no NetBird routed network, 'off' = the built-in node is not connected,
// 'failed' = the node could not open a forwarder; all three mean the request went (or failed) directly.
export type MeshPath = 'direct' | 'mesh' | 'outside' | 'off' | 'failed';

export type TorrentTestResult =
  | { ok: true; version: string; apiVersion: string; via?: 'direct' | 'mesh' }
  | { ok: false; error: string; certificate?: TorrentCertificate; path?: MeshPath };

// ---- Music scrobbling (ListenBrainz, Last.fm) ----

export interface ScrobbleState {
  // ListenBrainz user name once a token is saved ('' when ListenBrainz did not say).
  listenbrainz: { user: string | null };
  // apiKey: '' until the user enters their Last.fm API key; user once authorized; authUrl while waiting for the user.
  lastfm: { apiKey: string; user: string | null; authUrl: string | null };
  // Listens waiting to be sent again.
  queued: number;
  error?: string;
}

// ---- Trakt (client-side scrobbling, OAuth device code) ----

export interface TraktServer {
  serverId: string;
  name: string;
  // The server runs the Trakt plugin: true / false when the plugin list could be read (admins), else null.
  plugin: boolean | null;
}

export interface TraktState {
  // '' until the user enters their Trakt application's client id.
  clientId: string;
  // Trakt username once authorized.
  user: string | null;
  // Device code waiting for the user at the verification URL.
  pending: { userCode: string; url: string; expiresAt: number } | null;
  error?: string;
  servers: TraktServer[];
}

export interface TorrentAddRequest {
  magnets: string[];
  files: { name: string; data: Uint8Array }[];
  category: string;
  savePath: string;
  paused: boolean;
  sequential: boolean;
}

export type TorrentAction = 'pause' | 'resume' | 'recheck' | 'force-start' | 'priority-up' | 'priority-down' | 'sequential' | 'first-last';

// ---- Cast (docs/specs/cast-spec.md §2; CA-04: Sessions-API targets) ----

export type CastKind = 'session' | 'dlna' | 'cast';
export type CastSection = 'apps' | 'dlna' | 'chromecast';

// §2.1. Arrays rather than Sets so the target crosses IPC as is.
export interface CastTarget {
  // "s:<serverId>:<sessionId>" | "d:<udn>" | "c:<castId>"
  key: string;
  kind: CastKind;
  section: CastSection;
  name: string;
  // Client name and version, or the model; server DLNA sessions add `via` (the server's name).
  detail: string;
  via?: string;
  serverId?: string;
  // Sessions: the DeviceId (mirror lookups, dedupe with SSDP renderers).
  deviceId?: string;
  // Sessions: SupportedCommands, compared case-insensitively. dlna/cast: the synthetic set of §2.3.
  commands: string[];
  mediaTypes: ('Audio' | 'Video')[];
  // The picker's icon: a speaker (audio only, Nest or DLNA audio renderer), a speaker group, or a screen (default).
  device?: 'speaker' | 'group';
}

// What `start` plays; absent = hand off what the player is playing (§2.4).
export interface CastStartOptions {
  itemIds: string[];
  startIndex?: number;
  positionTicks?: number;
  msid?: string;
  audio?: number;
  // -1 = subtitles off.
  sub?: number;
}

// §2.3: which remote controls are enabled for the active target.
export interface CastControls {
  transport: boolean;
  seekRelative: boolean;
  nextPrev: boolean;
  volume: boolean;
  mute: boolean;
  audio: boolean;
  subtitles: boolean;
  rate: boolean;
  message: boolean;
}

export type CastCommand =
  | { type: 'toggle-pause' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'seek'; positionTicks: number }
  | { type: 'seek-relative'; deltaTicks: number }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'volume'; value: number }
  | { type: 'mute'; value: boolean }
  | { type: 'audio'; index: number }
  | { type: 'subtitle'; index: number }
  | { type: 'rate'; value: number };

// The active cast, as mirrored from the target. null = not casting.
export interface CastState {
  target: CastTarget;
  // starting: sent, waiting for the target to show the item (10 s); failed: break-before-make channel handoff that
  // did not take (the bar offers "Reprendre ici").
  status: 'starting' | 'playing' | 'failed';
  item?: { id: string; name: string; type?: string; seriesName?: string; runTimeTicks?: number; artists?: string[]; album?: string; imageItemId?: string; imageTag?: string };
  // Direct casts with a queue (music): where the device is in it.
  queue?: { index: number; length: number };
  serverId: string;
  positionTicks: number;
  paused: boolean;
  volume?: number;
  muted?: boolean;
  audio?: number;
  sub?: number;
  controls: CastControls;
}

// ---- Events pushed from main ----

export interface ServerEvent {
  type: string;
  data: unknown;
  serverId?: string;
}

// The desktop update check (features/app-updates.ts). offline and error stay silent outside Settings.
export interface AppUpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'offline' | 'error';
  update: AppUpdate | null;
  // "Later" on this version: no notice, Settings still shows it.
  dismissed: boolean;
}


export interface Toast {
  kind: 'info' | 'success' | 'error';
  message: string;
  // How long it stays up; the renderer's default without one.
  ms?: number;
}

// ---- File sources (file-sources-spec §2.1) ----

export type FileProtocol = 'local' | 'webdav' | 'smb';

// What the renderer sees of a source: no credentials, no URL with userinfo.
export interface FileSourceInfo {
  id: string;
  name: string;
  protocol: FileProtocol;
  display: string;
  // A plain http:// WebDAV address (display drops the scheme): Connect needs the acknowledgement unless tls is
  // already 'insecure-http'.
  http?: boolean;
  hasCredentials: boolean;
  tls?: 'verify' | 'pin' | 'insecure-http';
  // pending: imported from a settings file, nothing contacts it until the user connects it.
  status: 'signed-in' | 'offline' | 'pending';
  // A photo source: its index (count: files found so far while scanning).
  photos?: PhotoScanStatus;
}

export interface PhotoScanStatus {
  state: 'scanning' | 'ready' | 'error';
  count: number;
  scannedAt?: number;
}

// A service "Find on this network" heard of (mDNS, file-sources-spec §6.2): it only fills the Add sheet.
export interface FileDiscovered {
  protocol: 'webdav' | 'smb';
  name: string;
  // webdav: http(s)://host:port/path from the TXT path=; smb: \\host\ (the user adds the share).
  url: string;
  // TXT u=: pre-fills the user field.
  user?: string;
}

export interface FileSourceInput {
  protocol: FileProtocol;
  // local: the path pickFolder() returned; webdav/smb: what the user typed (parseSourceUrl forms).
  url: string;
  name?: string;
  user?: string;
  pass?: string;
  domain?: string;
  // The SHA-256 of a certificate the user chose to trust for this source (from a certUntrusted result).
  pin?: string;
  // "I understand the password travels unencrypted" (plain http with credentials).
  insecure?: boolean;
  // Added under Settings > Photo sources: a photo library indexed from the folder tree.
  photos?: boolean;
}

export type FileTestCode = 'ok' | 'auth' | 'notFound' | 'certUntrusted' | 'certChanged' | 'digestOnly' | 'smb1' | 'offline' | 'insecure' | 'invalid' | 'unsupported';

export interface FileTestResult {
  code: FileTestCode;
  // ok: entries in the root.
  count?: number;
  // certUntrusted / certChanged: the leaf certificate to show before trusting it.
  cert?: { sha256: string; subject: string; issuer: string; validFrom: string; validTo: string; pinned?: string };
}

// ---- IPTV sources (main/iptv) ----

// What the renderer sees of an IPTV source: never its URLs (they may carry Xtream credentials), only hosts.
export interface IptvSourceInfo {
  id: string;
  name: string;
  // Host of the playlist (or the file name), and of the guide when there is one.
  display: string;
  guide?: string;
  channels: number;
  programmes: number;
  updatedAt: number;
  state: 'loading' | 'ready' | 'error';
  // The guide failed (the channels still work).
  guideError?: boolean;
}

export interface IptvSourceInput {
  name?: string;
  // http(s) URL, or a path pickFile('playlist') returned.
  playlist: string;
  guide?: string;
}

// ---- The bridge exposed to the renderer as window.wicaby ----

export type Unsubscribe = () => void;
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface WicabyBridge {
  app: {
    info(): Promise<AppInfo>;
    quit(): Promise<void>;
    openExternal(url: string): Promise<void>;
    openPath(kind: 'logs' | 'downloads' | 'mpv-config' | 'data'): Promise<void>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
    // Bytes used by the HTTP cache (images, API), the comic cache and the logs.
    storage(): Promise<StorageUsage>;
    clearStorage(kind: 'http' | 'logs'): Promise<StorageUsage>;
  };
  updates: {
    state(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    // Main opens the URL it validated; the renderer never passes one.
    open(target: 'notes' | 'download' | 'repo'): Promise<void>;
    dismiss(): Promise<AppUpdateState>;
    onState(cb: (state: AppUpdateState) => void): Unsubscribe;
  };
  // Linux: the Hyprland / Omarchy palette, pushed again when the desktop theme changes.
  desktopTheme: {
    get(): Promise<DesktopThemeState>;
    onChange(cb: (state: DesktopThemeState) => void): Unsubscribe;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    toggleFullscreen(): Promise<void>;
    getState(): Promise<WindowState>;
    onState(cb: (state: WindowState) => void): Unsubscribe;
    // Music mini player (MU-10): open it, close it (the main window comes back) or expand (close + focus main).
    mini(action: 'open' | 'close' | 'toggle'): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: DeepPartial<Settings>): Promise<Settings>;
    pickFolder(): Promise<string | null>;
    pickMpv(): Promise<string | null>;
    onChange(cb: (settings: Settings) => void): Unsubscribe;
    // mpv's output devices, from the running player or a short-lived `mpv --audio-device=help`.
    audioDevices(): Promise<AudioDevice[]>;
    // File dialogs; import returns null when cancelled.
    exportFile(): Promise<boolean>;
    importFile(): Promise<Settings | null>;
    reset(): Promise<Settings>;
  };
  servers: {
    discover(): Promise<DiscoveredServer[]>;
    list(): Promise<ServerInfo[]>;
    add(address: string): Promise<ServerInfo>;
    embyConnect(username: string, password: string): Promise<ServerInfo[]>;
    // Connects this server too; the other sessions stay up.
    select(id: string): Promise<SessionState>;
    remove(id: string): Promise<void>;
    wake(id: string): Promise<boolean>;
    // Plex (plex-spec §5): link with a code, then poll every 2 s until linked or expired.
    plexLink(): Promise<PlexLinkPin>;
    plexPoll(): Promise<PlexLinkPoll>;
    plexAccounts(): Promise<PlexAccount[]>;
    plexUnlink(accountId: string): Promise<void>;
    plexSetHidden(id: string, hidden: boolean): Promise<ServerInfo[]>;
    // D-3: send this server's token to the http LAN address it answered at (session.confirm).
    plexConfirm(id: string, address: string): Promise<SessionState>;
  };
  session: {
    get(): Promise<SessionState>;
    // serverId defaults to the primary server; disconnect() without it closes every session.
    publicUsers(serverId?: string): Promise<PublicUser[]>;
    login(username: string, password: string, serverId?: string): Promise<SessionState>;
    // Jellyfin Quick Connect: starts a request (its code), then polls it until approved (the session). null: not offered.
    quickConnect(serverId?: string): Promise<{ code: string } | { state: SessionState } | null>;
    logout(serverId?: string): Promise<SessionState>;
    disconnect(serverId?: string): Promise<SessionState>;
    onChange(cb: (state: SessionState) => void): Unsubscribe;
  };
  api: {
    // serverId defaults to the primary server.
    get<T = unknown>(path: string, query?: Query, serverId?: string): Promise<T>;
    post<T = unknown>(path: string, query?: Query, body?: unknown, serverId?: string): Promise<T>;
    del<T = unknown>(path: string, query?: Query, serverId?: string): Promise<T>;
    // Admin endpoints only (a few Jellyfin config routes); main whitelists GET/POST/DELETE/PUT.
    put<T = unknown>(path: string, query?: Query, body?: unknown, serverId?: string): Promise<T>;
    // POST /Items/{id}/Images/{type} with the file as base64 (admin). jpeg/png/webp/gif, 20 MB max.
    uploadImage(itemId: string, type: string, mime: string, data: Uint8Array, serverId?: string): Promise<void>;
  };
  playback: {
    play(request: PlayRequest): Promise<void>;
    command(command: PlaybackCommand): Promise<void>;
    getState(): Promise<PlaybackState>;
    onState(cb: (state: PlaybackState) => void): Unsubscribe;
    // The music playing in the film or episode, recognised by Shazam from a fingerprint of the last seconds.
    identifySong(): Promise<SongIdResult>;
  };
  music: {
    // MU-13: lyrics from lrclib.net for a track the server has none for; null when off, not found or failed.
    lrclib(track: LrclibTrack): Promise<Lyrics | null>;
  };
  htmlPlayer: {
    onLoad(cb: (load: HtmlPlayerLoad) => void): Unsubscribe;
    onCommand(cb: (command: HtmlPlayerCommand) => void): Unsubscribe;
    emit(event: HtmlPlayerEvent): void;
  };
  downloads: {
    list(): Promise<DownloadEntry[]>;
    add(itemIds: string[], serverId?: string): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    onChange(cb: (entries: DownloadEntry[]) => void): Unsubscribe;
  };
  // File sources (file-sources-spec §6, §7): credentials go in, never come back out.
  files: {
    list(): Promise<FileSourceInfo[]>;
    // Nothing is stored: one listing of the root with these settings.
    test(input: FileSourceInput): Promise<FileTestResult>;
    add(input: FileSourceInput): Promise<FileSourceInfo>;
    remove(id: string): Promise<void>;
    rename(id: string, name: string): Promise<FileSourceInfo>;
    // Tests, then stores. An empty user keeps the stored credentials (a re-test); insecure is the http
    // acknowledgement (code 'insecure' without it on a plain http source not yet acknowledged).
    setCredentials(id: string, user: string, pass: string, domain?: string, insecure?: boolean): Promise<FileTestResult>;
    // Pins the certificate a setCredentials() of this source just showed (cert.sha256); Add uses input.pin.
    trustCert(id: string, sha256: string): Promise<FileSourceInfo>;
    // One mDNS query, 2.5 s of answers; nothing connects.
    discover(): Promise<FileDiscovered[]>;
    // Main shows the OS folder picker; null when cancelled.
    pickFolder(): Promise<string | null>;
    // Drops the listing cache of one source; a photo source also rescans its folder tree (in the background).
    refresh(id: string): Promise<void>;
  };
  iptv: {
    list(): Promise<IptvSourceInfo[]>;
    // Fetches and parses the playlist first: nothing is stored when that fails (the error says why).
    add(input: IptvSourceInput): Promise<IptvSourceInfo>;
    remove(id: string): Promise<void>;
    // Playlist and guide again, now.
    refresh(id: string): Promise<IptvSourceInfo>;
    // Main shows the OS file picker; null when cancelled.
    pickFile(kind: 'playlist' | 'guide'): Promise<string | null>;
  };
  photos: {
    // The slideshow keeps the display awake (powerSaveBlocker 'prevent-display-sleep') while on.
    keepAwake(on: boolean): Promise<void>;
    // Immich sources (photos spec PH-12): the API key goes in once and never comes back out.
    immich: {
      sources(): Promise<ImmichSource[]>;
      onSources(cb: (sources: ImmichSource[]) => void): Unsubscribe;
      // Nothing is stored: version, key and permissions.
      test(url: string, key: string): Promise<ImmichTestResult>;
      add(url: string, key: string): Promise<ImmichTestResult & { source?: ImmichSource }>;
      remove(id: string): Promise<void>;
      // An allow-listed JSON call, path relative to /api. Fails with "immich:<status>" (403: a missing permission).
      request<T = unknown>(id: string, method: 'GET' | 'POST' | 'PUT', path: string, query?: Query, body?: unknown): Promise<T>;
      // Into the downloads folder; resolves with the file's path.
      saveOriginal(id: string, assetId: string): Promise<string>;
    };
  };
  comics: {
    open(itemId: string, serverId?: string): Promise<ComicInfo>;
    saveProgress(itemId: string, page: number, pageCount: number, serverId?: string): Promise<void>;
  };
  vpn: {
    status(): Promise<VpnStatus[]>;
    connect(kind: VpnKind, options?: VpnConnectOptions): Promise<VpnConnectResult>;
    // probe false: the peers alone, without asking each one for a media server (the slow part).
    peers(kind: VpnKind, probe?: boolean): Promise<VpnPeer[]>;
    // Redacted plain text for a support request (onboarding spec 3.1 and 3.5).
    diagnostics(): Promise<string>;
    // Wicaby's own userspace node on a Tailscale or NetBird mesh; sign-in goes
    // through connect('embedded', …). state 'stopped' = signed out / turned off,
    // 'not-installed' = this build ships without the helper.
    embedded: {
      status(): Promise<VpnStatus>;
      logout(): Promise<VpnStatus>;
      // Stops the node and keeps its sign-in: connect('embedded') turns it back on.
      turnOff(): Promise<VpnStatus>;
      onChange(cb: (status: VpnStatus) => void): Unsubscribe;
    };
  };
  torrents: {
    state(): Promise<TorrentsState>;
    onState(cb: (state: TorrentsState) => void): Unsubscribe;
    // fg: list on screen (1.5 s), bg: window in the background (10 s), off: list not shown.
    watch(mode: 'fg' | 'bg' | 'off'): Promise<void>;
    test(config: TorrentConfig): Promise<TorrentTestResult>;
    configure(config: TorrentConfig): Promise<TorrentTestResult>;
    forget(): Promise<void>;
    trustCertificate(host: string, fingerprint: string): Promise<void>;
    add(request: TorrentAddRequest): Promise<void>;
    action(hashes: string[], action: TorrentAction): Promise<void>;
    remove(hashes: string[], deleteFiles: boolean): Promise<void>;
    setCategory(hashes: string[], category: string): Promise<void>;
    toggleAltSpeed(): Promise<void>;
    // The clipboard text, only when it is a magnet link.
    clipboardMagnet(): Promise<string | null>;
    // Magnet link handed over by Windows (magnet: handler), consumed once.
    takeMagnet(): Promise<string | null>;
    onMagnet(cb: () => void): Unsubscribe;
  };
  // External ratings (shared/ratings.ts): the MDBList key goes in once and never comes back out.
  ratings: {
    configured(): Promise<boolean>;
    // '' turns them off; true when a key is set.
    setKey(key: string): Promise<boolean>;
    // path: mdblistPath(item). [] when off, unknown or unreachable.
    get(path: string): Promise<ExternalRating[]>;
  };
  trakt: {
    state(): Promise<TraktState>;
    onState(cb: (state: TraktState) => void): Unsubscribe;
    // Stores the client id and secret, then starts the device-code flow (state.pending).
    connect(clientId: string, clientSecret: string): Promise<TraktState>;
    cancel(): Promise<TraktState>;
    // Revokes the token and forgets the account.
    disconnect(): Promise<TraktState>;
  };
  scrobble: {
    state(): Promise<ScrobbleState>;
    onState(cb: (state: ScrobbleState) => void): Unsubscribe;
    // Validates the user token, then stores it.
    connectListenBrainz(token: string): Promise<ScrobbleState>;
    disconnectListenBrainz(): Promise<ScrobbleState>;
    // Stores the API key and secret, then starts the web authorization (state.lastfm.authUrl).
    connectLastfm(apiKey: string, secret: string): Promise<ScrobbleState>;
    cancelLastfm(): Promise<ScrobbleState>;
    disconnectLastfm(): Promise<ScrobbleState>;
  };
  reminders: {
    list(): Promise<LiveReminder[]>;
    // Sets the reminder of r.programId, or clears it when set; true when one is set now.
    toggle(r: LiveReminder): Promise<boolean>;
    // "Rester ici": cancels the running auto-tune countdown.
    stay(): Promise<void>;
    onCountdown(cb: (c: ReminderCountdown | null) => void): Unsubscribe;
  };
  // Cast (cast-spec CA-04). The renderer never gets a token: main sends every command.
  cast: {
    // The item's server lists the targets; rows found later arrive through onTargets while the picker is open.
    targets(itemId: string, serverId?: string): Promise<CastTarget[]>;
    onTargets(cb: (targets: CastTarget[]) => void): Unsubscribe;
    start(targetKey: string, options?: CastStartOptions): Promise<void>;
    control(command: CastCommand): Promise<void>;
    stop(): Promise<void>;
    // "Reprendre ici": stops the target, then plays here from its position.
    takeBack(): Promise<void>;
    getState(): Promise<CastState | null>;
    onState(cb: (state: CastState | null) => void): Unsubscribe;
  };
  // Jellyfin SyncPlay (watch together). Optional: a platform without it hides the UI. Main (or the web TV app's
  // own implementation) applies the group's pause, seek and play to the player; the renderer only picks a group.
  // serverId: the Jellyfin server to use, the one playing (else the primary) when absent.
  syncplay?: {
    list(serverId?: string): Promise<SyncPlayGroup[]>;
    // While something plays on that server, the new group starts with it.
    create(name: string, serverId?: string): Promise<void>;
    join(groupId: string, serverId?: string): Promise<void>;
    leave(): Promise<void>;
    current(): SyncPlayGroup | null;
    onChange(cb: (g: SyncPlayGroup | null) => void): Unsubscribe;
  };
  events: {
    onServerEvent(cb: (event: ServerEvent) => void): Unsubscribe;
    onNavigate(cb: (route: string) => void): Unsubscribe;
    onToast(cb: (toast: Toast) => void): Unsubscribe;
  };
}

// An Immich photo source (photos spec §3.2). Its key stays in main's vault.
export interface ImmichSource {
  id: string;
  name: string;
  url: string;
}

// error: url (malformed), network, server (not an Immich answer), version (older than 2.0), auth (key refused),
// scope (the key lacks asset.read). missing: the optional permissions the key lacks.
export interface ImmichTestResult {
  ok: boolean;
  version?: string;
  error?: 'url' | 'network' | 'server' | 'version' | 'auth' | 'scope';
  missing: string[];
}

// A SyncPlay group (Jellyfin GroupInfoDto); members are user names.
export interface SyncPlayGroup {
  id: string;
  name: string;
  members: string[];
  state: 'idle' | 'waiting' | 'paused' | 'playing';
}

// Channel names. Invoke channels return a promise; send channels are fire and forget.
export const Channels = {
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appOpenExternal: 'app:open-external',
  appOpenPath: 'app:open-path',
  appStorage: 'app:storage',
  appClearStorage: 'app:clear-storage',
  appLog: 'app:log',
  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesOpen: 'updates:open',
  updatesDismiss: 'updates:dismiss',
  updatesChanged: 'updates:changed',
  desktopThemeGet: 'desktop-theme:get',
  desktopThemeChanged: 'desktop-theme:changed',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowToggleFullscreen: 'window:toggle-fullscreen',
  windowGetState: 'window:get-state',
  windowState: 'window:state',
  windowMini: 'window:mini',
  musicLrclib: 'music:lrclib',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickFolder: 'settings:pick-folder',
  settingsPickMpv: 'settings:pick-mpv',
  settingsAudioDevices: 'settings:audio-devices',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsReset: 'settings:reset',
  settingsChanged: 'settings:changed',
  serversDiscover: 'servers:discover',
  serversList: 'servers:list',
  serversAdd: 'servers:add',
  serversEmbyConnect: 'servers:emby-connect',
  serversSelect: 'servers:select',
  serversRemove: 'servers:remove',
  serversWake: 'servers:wake',
  serversPlexLink: 'servers:plex-link',
  serversPlexPoll: 'servers:plex-poll',
  serversPlexAccounts: 'servers:plex-accounts',
  serversPlexUnlink: 'servers:plex-unlink',
  serversPlexSetHidden: 'servers:plex-set-hidden',
  serversPlexConfirm: 'servers:plex-confirm',
  sessionGet: 'session:get',
  sessionPublicUsers: 'session:public-users',
  sessionLogin: 'session:login',
  sessionQuickConnect: 'session:quick-connect',
  sessionLogout: 'session:logout',
  sessionDisconnect: 'session:disconnect',
  sessionChanged: 'session:changed',
  apiRequest: 'api:request',
  apiUploadImage: 'api:upload-image',
  playbackPlay: 'playback:play',
  playbackCommand: 'playback:command',
  playbackGetState: 'playback:get-state',
  playbackState: 'playback:state',
  playbackIdentifySong: 'playback:identify-song',
  htmlPlayerLoad: 'html-player:load',
  htmlPlayerCommand: 'html-player:command',
  htmlPlayerEvent: 'html-player:event',
  videoDrawFailed: 'video:draw-failed',
  downloadsList: 'downloads:list',
  downloadsAdd: 'downloads:add',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsRemove: 'downloads:remove',
  downloadsReveal: 'downloads:reveal',
  downloadsChanged: 'downloads:changed',
  comicsOpen: 'comics:open',
  comicsSaveProgress: 'comics:save-progress',
  vpnStatus: 'vpn:status',
  vpnConnect: 'vpn:connect',
  vpnPeers: 'vpn:peers',
  vpnEmbeddedStatus: 'vpn:embedded-status',
  vpnEmbeddedLogout: 'vpn:embedded-logout',
  vpnEmbeddedChanged: 'vpn:embedded-changed',
  vpnEmbeddedTurnOff: 'vpn:embedded-turn-off',
  vpnDiagnostics: 'vpn:diagnostics',
  ratingsConfigured: 'ratings:configured',
  ratingsSetKey: 'ratings:set-key',
  ratingsGet: 'ratings:get',
  scrobbleState: 'scrobble:state',
  scrobbleChanged: 'scrobble:changed',
  scrobbleLbConnect: 'scrobble:lb-connect',
  scrobbleLbDisconnect: 'scrobble:lb-disconnect',
  scrobbleLastfmConnect: 'scrobble:lastfm-connect',
  scrobbleLastfmCancel: 'scrobble:lastfm-cancel',
  scrobbleLastfmDisconnect: 'scrobble:lastfm-disconnect',
  traktState: 'trakt:state',
  traktChanged: 'trakt:changed',
  traktConnect: 'trakt:connect',
  traktCancel: 'trakt:cancel',
  traktDisconnect: 'trakt:disconnect',
  torrentsState: 'torrents:state',
  torrentsChanged: 'torrents:changed',
  torrentsWatch: 'torrents:watch',
  torrentsTest: 'torrents:test',
  torrentsConfigure: 'torrents:configure',
  torrentsForget: 'torrents:forget',
  torrentsTrustCert: 'torrents:trust-cert',
  torrentsAdd: 'torrents:add',
  torrentsAction: 'torrents:action',
  torrentsRemove: 'torrents:remove',
  torrentsSetCategory: 'torrents:set-category',
  torrentsToggleAltSpeed: 'torrents:toggle-alt-speed',
  torrentsClipboardMagnet: 'torrents:clipboard-magnet',
  torrentsTakeMagnet: 'torrents:take-magnet',
  torrentsMagnet: 'torrents:magnet',
  remindersList: 'reminders:list',
  remindersToggle: 'reminders:toggle',
  remindersStay: 'reminders:stay',
  remindersCountdown: 'reminders:countdown',
  castTargets: 'cast:targets',
  castTargetsUpdated: 'cast:targets-updated',
  castStart: 'cast:start',
  castControl: 'cast:control',
  castStop: 'cast:stop',
  castTakeBack: 'cast:take-back',
  castGetState: 'cast:get-state',
  castState: 'cast:state',
  syncplayList: 'syncplay:list',
  syncplayCreate: 'syncplay:create',
  syncplayJoin: 'syncplay:join',
  syncplayLeave: 'syncplay:leave',
  syncplayGet: 'syncplay:get',
  syncplayChanged: 'syncplay:changed',
  serverEvent: 'events:server',
  navigate: 'events:navigate',
  toast: 'events:toast',
  photosKeepAwake: 'photos:keep-awake',
  immichSources: 'immich:sources',
  immichChanged: 'immich:changed',
  immichTest: 'immich:test',
  immichAdd: 'immich:add',
  immichRemove: 'immich:remove',
  immichRequest: 'immich:request',
  immichSaveOriginal: 'immich:save-original',
  filesList: 'files:list',
  filesTest: 'files:test',
  filesAdd: 'files:add',
  filesRemove: 'files:remove',
  filesRename: 'files:rename',
  filesSetCredentials: 'files:set-credentials',
  filesTrustCert: 'files:trust-cert',
  filesDiscover: 'files:discover',
  filesPickFolder: 'files:pick-folder',
  filesRefresh: 'files:refresh',
  iptvList: 'iptv:list',
  iptvAdd: 'iptv:add',
  iptvRemove: 'iptv:remove',
  iptvRefresh: 'iptv:refresh',
  iptvPickFile: 'iptv:pick-file',
} as const;

export const MEDIA_SCHEME = 'wicaby-media';
export const APP_SCHEME = 'app';
export const APP_HOST = 'wicaby';
export const TICKS_PER_MS = 10_000;
