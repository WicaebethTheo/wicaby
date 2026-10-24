// The playback service's shared types and pure helpers: the idle state, tracks, version labels,
// media URLs and server error codes. playback-service.ts re-exports what live-player.ts imports.
import { MEDIA_SCHEME, TICKS_PER_MS, type NowPlayingItem, type PlaybackState, type PlayMethod, type Track } from '../../shared/contract';
import type { BaseItem, MediaSource, MediaStream } from '../../shared/models';
import { fetchServer, resolveServerUrl, serverPath, stripTokenParams, type ApiClient } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import type { SettingsService } from '../core/settings';
import { t } from '../i18n';
import type { DownloadManager } from '../downloads/download-manager';
import type { DisplayModeSwitcher } from '../features/display-mode';
import type { MpvRender } from '../features/display-mode-linux';
import type { HdrModeSwitcher } from '../features/hdr-mode';
import type { WindowManager } from '../windows/window-manager';
import { isFilesId } from '../../shared/files/ids';
import { hdrFromStream } from '../../shared/hdr';
import { versionLabel, versionSignature } from '../../shared/quality-presets';
import { isAd, isSdh } from '../../shared/track-selection';
import type { ExternalSubtitle } from './player';
import type { LiveCurrent, LiveRestart } from '../livetv/live-player';

export interface PlaybackDeps {
  connection: ConnectionManager;
  settings: SettingsService;
  windows: WindowManager;
  downloads: DownloadManager;
  display: DisplayModeSwitcher;
  hdr: HdrModeSwitcher;
  // The mpv CLI; null is fine for video in texture mode, which runs libmpv in-process.
  mpvExe: () => string | null;
  // How mpv shows video (display-mode-linux.ts mpvRenderMode): wid embeds it (Windows, X11); native Wayland has no
  // X11 window for --wid, so texture (libmpv inside the playback window) or detached (mpv's own window). The service
  // drops from texture to detached for the session when texture mode fails at runtime.
  mpvRender: MpvRender;
  mpvConfigDir: string;
  deviceId: string;
  onMessage: (kind: 'info' | 'error', message: string) => void;
  // D8 (music-spec): where the music queue is kept between runs; none = not kept.
  musicQueueFile?: string;
}

export interface Current {
  item: BaseItem;
  source?: MediaSource;
  playSessionId?: string;
  playMethod: PlayMethod;
  offline: boolean;
  // A downloaded file, played from disk even while online: nothing to reconnect.
  local?: boolean;
  serverId?: string;
  userId?: string;
  audioIndex: number | null;
  subtitleIndex: number | null;
  kind: 'mpv' | 'html';
  trailer: boolean;
  live?: LiveCurrent;
  // The player's own list (LoadParams): X-03 appends a downloaded subtitle for mpv to sub-add in place.
  external?: ExternalSubtitle[];
  // A file source item (files/files-client.ts): duration and title go to its local progress ('tagged' once the
  // title was read).
  files?: boolean | 'tagged';
  // A Plex transcode that starts at the resume point (MediaSource.StartTimeTicks): the player counts from 0 there.
  baseMs?: number;
  // A Plex multi-part film played one part at a time (D-4: the HTML player, a transcode): where this part ends in
  // the whole film. The next part loads there; the duration stays the film's.
  partEndMs?: number;
  // Ended by the server (a Plex termination): no further report.
  terminated?: boolean;
}

export interface StartOptions {
  startMs?: number;
  mediaSourceId?: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  player?: 'mpv' | 'html';
  live?: LiveRestart;
  // X-02: the bitrate cap a live tune uses (the VOD path reads qualityCap itself).
  maxBitrate?: number;
  // X-02 switch: runs once the new PlaybackInfo resolved, before the new stream replaces the old one.
  beforeLoad?: () => Promise<void>;
  // D-4: the next part of a multi-part Plex film continues this session.
  playSessionId?: string;
}

export function idle(volume = 100, muted = false): PlaybackState {
  return {
    active: false,
    positionMs: 0,
    durationMs: 0,
    paused: false,
    buffering: false,
    volume,
    muted,
    rate: 1,
    audioTracks: [],
    subtitleTracks: [],
    audioIndex: null,
    subtitleIndex: null,
    queueIndex: 0,
    queueLength: 0,
    fullscreen: false,
    offline: false,
    stats: {},
  };
}

export function trackLabel(s: MediaStream): string {
  return s.DisplayTitle || [s.Language, s.Codec?.toUpperCase()].filter(Boolean).join(' · ') || t('main.playback.trackFallback', { index: s.Index });
}

// X-02 version label and signature ("2160p HEVC DV"), from the source's video stream.
export const videoOf = (s: MediaSource | undefined) => s?.MediaStreams?.find((m) => m.Type === 'Video');
export const sourceLabel = (s: MediaSource): string => versionLabel(videoOf(s), hdrFromStream(videoOf(s))?.kind) || s.Name || s.Id;
export const sourceSignature = (s: MediaSource): string => versionSignature(videoOf(s), hdrFromStream(videoOf(s))?.kind);
// The sheet's labels: two versions that read the same (a dub and a VOST, both "1080p H.264") get the
// source name the item page shows, then a number if still equal.
export function sourceLabels(sources: MediaSource[]): string[] {
  const base = sources.map(sourceLabel);
  const named = base.map((l, i) => (base.filter((b) => b === l).length > 1 && sources[i].Name && sources[i].Name !== l ? `${l} · ${sources[i].Name}` : l));
  return named.map((l, i) => (named.filter((n) => n === l).length > 1 ? `${l} (${i + 1})` : l));
}

// X-02 version switch: the stream of the other version with the same type, language and forced flag
// (the same codec first). Index numbers differ between versions.
export function sameTrack(from: MediaStream[], to: MediaStream[], index: number | null): number | undefined {
  const s = index === null ? undefined : from.find((m) => m.Index === index);
  if (!s) return undefined;
  const pool = to.filter((m) => m.Type === s.Type && m.Language === s.Language && Boolean(m.IsForced) === Boolean(s.IsForced));
  return (pool.find((m) => m.Codec === s.Codec) ?? pool[0])?.Index;
}

export function toTrack(s: MediaStream): Track {
  return {
    index: s.Index,
    label: trackLabel(s),
    language: s.Language,
    codec: s.Codec,
    isDefault: Boolean(s.IsDefault),
    isForced: Boolean(s.IsForced),
    isExternal: Boolean(s.IsExternal),
    sdh: s.Type === 'Subtitle' && isSdh(s),
    ad: s.Type === 'Audio' && isAd(s),
  };
}

// Item ids as both servers issue them (Emby: digits, Jellyfin: 32 hex), and file source ids ('p.' + base64url,
// shared/files/ids.ts). Checked before an id is put in a URL path: '../<other server id>/...' would otherwise
// reach another server.
export const validId = (id: unknown): id is string => typeof id === 'string' && (/^[A-Za-z0-9_-]{1,64}$/.test(id) || isFilesId(id));

// The protocol handler adds the auth headers: no token parameter ever reaches the renderer.
// A path with a dot segment, a backslash or an encoded slash is refused (throws).
export function mediaApiUrl(rel: string, serverId?: string): string {
  const clean = stripTokenParams(rel);
  const path = clean.split(/[?#]/)[0];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = '..';
  }
  if ((serverId && !validId(serverId)) ||/(^|[\\/])\.\.?([\\/]|$)/.test(decoded) || /%2f|%5c|\\/i.test(path) || path.startsWith('//'))
    throw new Error(t('errors.playback.noPlayMethod'));
  return `${MEDIA_SCHEME}://api${serverId ? `/${serverId}` : ''}${clean.startsWith('/') ? clean : `/${clean}`}`;
}

// The URL to play without the auth header: the final URL of a direct-play stream the server
// redirects to another origin (http(s) only, token parameters removed). Null when it does not
// redirect. When HEAD fails or times out, a one-byte GET asks again; when that fails too,
// playback fails (it might redirect, FFmpeg would follow with the header). A redirect to any
// other scheme refuses playback.
export async function redirectTarget(api: ApiClient, url: string): Promise<string | null> {
  for (const [method, headers] of [['HEAD', {}], ['GET', { Range: 'bytes=0-0' }]] as const) {
    try {
      const hop = await fetchServer(api, url, { method, headers: { ...api.authHeaders(), ...headers }, timeoutMs: 5000 });
      if ('foreign' in hop) return hop.foreign;
      hop.response.body?.cancel().catch(() => undefined);
      return null;
    } catch (err) {
      if (err instanceof Error && err.message === 'redirect refused') throw new Error(t('errors.playback.noPlayMethod'));
    }
  }
  throw new Error(t('errors.playback.unreachable'));
}

// A server subtitle URL for the player, or null when it cannot be one (a path the
// protocol handler would refuse, a form resolveServerUrl does not resolve).
export function subtitleUrl(api: ApiClient, kind: 'mpv' | 'html', deliveryUrl: string, sid: string | undefined): string | null {
  if (kind === 'mpv') return resolveServerUrl(api, deliveryUrl);
  const rel = serverPath(api, deliveryUrl);
  try {
    return rel === null ? null : mediaApiUrl(rel, sid);
  } catch {
    return null;
  }
}

export function nowPlaying(item: BaseItem, serverId?: string): NowPlayingItem {
  const ownPrimary = item.ImageTags?.Primary;
  return {
    id: item.Id,
    serverId,
    name: item.Name,
    type: item.Type,
    seriesName: item.SeriesName,
    seasonNumber: item.ParentIndexNumber,
    episodeNumber: item.IndexNumber,
    year: item.ProductionYear,
    imageItemId: ownPrimary ? item.Id : item.SeriesId,
    imageTag: ownPrimary ?? item.SeriesPrimaryImageTag,
    backdropItemId: item.BackdropImageTags?.length ? item.Id : item.ParentBackdropItemId,
    backdropTag: item.BackdropImageTags?.[0] ?? item.ParentBackdropImageTags?.[0],
    chapters: (item.Chapters ?? [])
      .map((c, i) => ({ c, index: c.ChapterIndex ?? i }))
      .filter(({ c }) => !c.MarkerType || c.MarkerType === 'Chapter')
      .map(({ c, index }, n) => ({ name: c.Name || `Chapitre ${n + 1}`, startMs: c.StartPositionTicks / TICKS_PER_MS, index, imageTag: c.ImageTag })),
    // A track: its album and artists, and the album's art (SMTC, music-spec §4.2).
    ...(item.MediaType === 'Audio'
      ? {
          album: item.Album,
          albumId: item.AlbumId,
          artists: item.Artists?.length ? item.Artists : item.ArtistItems?.map((a) => a.Name),
          albumArtist: item.AlbumArtist,
          indexNumber: item.IndexNumber,
          ...(item.AlbumId && item.AlbumPrimaryImageTag ? { imageItemId: item.AlbumId, imageTag: item.AlbumPrimaryImageTag } : {}),
        }
      : {}),
  };
}

export function errorText(code: string): string {
  switch (code) {
    case 'NotAllowed':
      return t('errors.playback.notAllowed');
    case 'NoCompatibleStream':
      return t('errors.playback.noCompatibleStream');
    case 'RateLimitExceeded':
      return t('errors.playback.rateLimit');
    default:
      return t('errors.playback.refused', { code });
  }
}
