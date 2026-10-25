// Library analytics (Administration → Analytics, issue #17): one compact row per scanned item, and the
// aggregation over those rows. Pure, so tools/checks/library-analytics-check.mjs runs it on fixtures.
import { hdrFromStream, type HdrKind } from './hdr';
import type { BaseItem } from './models';

// Item types the scan asks for. The first five have their own share; the rest count as "other".
export const MEDIA_TYPES = ['Movie', 'Series', 'Episode', 'MusicAlbum', 'Audio'];
export const SCAN_TYPES = [...MEDIA_TYPES, 'MusicVideo', 'Video', 'AudioBook', 'Book'];

// One page of a library scan (/Users/{id}/Items on Emby, /Items?userId= on Jellyfin).
export function scanQuery(parentId: string, start: number, limit: number): Record<string, string | number | boolean> {
  return {
    ParentId: parentId,
    Recursive: true,
    IncludeItemTypes: SCAN_TYPES.join(','),
    Fields: 'MediaSources,MediaStreams,Path',
    SortBy: 'SortName',
    StartIndex: start,
    Limit: limit,
    EnableTotalRecordCount: true,
    EnableImages: false,
    EnableUserData: false,
  };
}

export type Resolution = '4k' | '1080p' | '720p' | 'sd';
export const RESOLUTIONS: Resolution[] = ['4k', '1080p', '720p', 'sd'];
export type Hdr = Exclude<HdrKind, 'sdr'>;

// Small enough to cache a whole library: labels are already normalised.
export interface ScanRow {
  id: string;
  name: string;
  type: string;
  // Library (view) id the row was scanned under.
  lib: string;
  path?: string;
  container?: string;
  size?: number;
  bitrate?: number;
  video?: string;
  width?: number;
  height?: number;
  res?: Resolution;
  hdr?: Hdr;
  audio?: string[];
  // Video only: distinct audio languages (a missing tag counts as one) and subtitle tracks.
  langs?: number;
  subs?: number;
}

const VIDEO: Record<string, string> = {
  h264: 'H.264',
  avc: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1',
  mpeg4: 'MPEG-4',
  msmpeg4v3: 'MPEG-4',
  vc1: 'VC-1',
  wmv3: 'WMV',
  mjpeg: 'MJPEG',
};
const AUDIO: Record<string, string> = {
  aac: 'AAC',
  eac3: 'EAC3',
  ac3: 'AC3',
  truehd: 'TrueHD',
  dts: 'DTS',
  dca: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  mp2: 'MP2',
  vorbis: 'Vorbis',
  alac: 'ALAC',
  wmav2: 'WMA',
  ac4: 'AC-4',
};
const CONTAINER: Record<string, string> = {
  mkv: 'MKV',
  matroska: 'MKV',
  mp4: 'MP4',
  m4v: 'MP4',
  mov: 'MOV',
  avi: 'AVI',
  webm: 'WebM',
  ts: 'TS',
  mpegts: 'TS',
  m2ts: 'M2TS',
  wmv: 'WMV',
  asf: 'WMV',
  flv: 'FLV',
  ogv: 'OGG',
  ogg: 'OGG',
  iso: 'ISO',
  flac: 'FLAC',
  mp3: 'MP3',
  m4a: 'M4A',
  wav: 'WAV',
};

// '?' when the server names no codec; the page shows it as "Unknown".
export function videoCodec(codec?: string): string {
  const c = (codec ?? '').toLowerCase();
  return c ? (VIDEO[c] ?? c.toUpperCase()) : '?';
}

export function audioCodec(codec?: string, profile?: string): string {
  const c = (codec ?? '').toLowerCase();
  if (!c) return '?';
  if (c.startsWith('pcm')) return 'PCM';
  // Both servers report DTS-HD MA and DTS:X as codec "dts" with the variant in Profile.
  if ((c === 'dts' || c === 'dca') && /hd|ma|x/i.test(profile ?? '')) return 'DTS-HD';
  return AUDIO[c] ?? c.toUpperCase();
}

// The file extension wins: Emby names ffmpeg's demuxer family ("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm").
export function containerLabel(container?: string, path?: string): string | undefined {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(path ?? '')?.[1]?.toLowerCase();
  if (ext && CONTAINER[ext]) return CONTAINER[ext];
  const first = (container ?? '').toLowerCase().split(',')[0].trim();
  return first ? (CONTAINER[first] ?? first.toUpperCase()) : undefined;
}

// By width or height, so letterboxed (3840×1608) and cropped (1440×1080) frames land in their class.
export function resolution(width = 0, height = 0): Resolution | undefined {
  if (!width && !height) return undefined;
  if (width >= 3200 || height >= 2000) return '4k';
  if (width >= 1700 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  return 'sd';
}

// Only the first media source counts (the server's default version).
export function toRow(item: BaseItem, lib: string): ScanRow {
  const src = item.MediaSources?.[0];
  const streams = src?.MediaStreams ?? item.MediaStreams ?? [];
  const row: ScanRow = { id: item.Id, name: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name, type: item.Type, lib };
  const path = src?.Path ?? item.Path;
  if (path) row.path = path;
  const container = src || item.Container ? containerLabel(src?.Container ?? item.Container, path) : undefined;
  if (container) row.container = container;
  if (src?.Size) row.size = src.Size;
  if (src?.Bitrate) row.bitrate = src.Bitrate;
  const v = streams.find((s) => s.Type === 'Video');
  const audio = streams.filter((s) => s.Type === 'Audio');
  if (audio.length) row.audio = [...new Set(audio.map((s) => audioCodec(s.Codec, s.Profile)))];
  if (v) {
    row.video = videoCodec(v.Codec);
    if (v.Width) row.width = v.Width;
    if (v.Height) row.height = v.Height;
    const res = resolution(v.Width, v.Height);
    if (res) row.res = res;
    const hdr = hdrFromStream(v)?.kind;
    if (hdr && hdr !== 'sdr') row.hdr = hdr;
    row.langs = new Set(audio.map((s) => (s.Language || 'und').toLowerCase())).size;
    row.subs = streams.filter((s) => s.Type === 'Subtitle').length;
  }
  return row;
}

export type Facet = 'type' | 'video' | 'audio' | 'container' | 'res' | 'hdr' | 'noSubs' | 'oneLang';

// The buckets a row falls in for one facet; aggregation and drill-down share it.
export function facetKeys(r: ScanRow, facet: Facet): string[] {
  switch (facet) {
    case 'type':
      return [MEDIA_TYPES.includes(r.type) ? r.type : 'other'];
    case 'video':
      return r.video ? [r.video] : [];
    case 'audio':
      return r.audio ?? [];
    case 'container':
      return r.container ? [r.container] : [];
    case 'res':
      return r.res ? [r.res] : [];
    case 'hdr':
      return r.hdr ? [r.hdr] : [];
    case 'noSubs':
      return r.video && !r.subs ? ['yes'] : [];
    case 'oneLang':
      return r.video && r.langs === 1 ? ['yes'] : [];
  }
}

export const inBucket = (r: ScanRow, facet: Facet, key: string) => facetKeys(r, facet).includes(key);

export interface Bucket {
  key: string;
  count: number;
  // 0–1, of the rows the facet applies to (types: every row; codecs, resolution, HDR: video rows…).
  pct: number;
}

export interface LibraryInfo {
  id: string;
  name: string;
  // CollectionType, 'mixed' when the server has none.
  type: string;
}

export interface LibraryStats extends LibraryInfo {
  total: number;
  // Per MEDIA_TYPES entry plus 'other'.
  counts: Record<string, number>;
  size: number;
  // Mean bits per second over the rows that report one; 0 when none does.
  bitrate: number;
}

export interface Analytics {
  total: number;
  libraries: number;
  size: number;
  types: Bucket[];
  video: Bucket[];
  audio: Bucket[];
  containers: Bucket[];
  resolutions: Bucket[];
  hdr: Bucket[];
  noSubs: Bucket;
  oneLang: Bucket;
  perLibrary: LibraryStats[];
}

function buckets(rows: ScanRow[], facet: Facet, order?: string[]): Bucket[] {
  const counts = new Map<string, number>((order ?? []).map((k) => [k, 0]));
  let applies = 0;
  for (const r of rows) {
    const keys = facetKeys(r, facet);
    // An item with two audio codecs counts once for each; its share is of the items with audio.
    if (keys.length || (facet === 'hdr' && r.video)) applies++;
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = [...counts].map(([key, count]) => ({ key, count, pct: applies ? count / applies : 0 }));
  return order ? out : out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

const share = (count: number, of: number): Bucket => ({ key: 'yes', count, pct: of ? count / of : 0 });

export function aggregate(rows: ScanRow[], libs: LibraryInfo[]): Analytics {
  const videoRows = rows.filter((r) => r.video).length;
  const perLibrary = libs.map((l): LibraryStats => {
    const mine = rows.filter((r) => r.lib === l.id);
    const counts: Record<string, number> = Object.fromEntries([...MEDIA_TYPES, 'other'].map((k) => [k, 0]));
    for (const r of mine) counts[facetKeys(r, 'type')[0]]++;
    const rated = mine.filter((r) => r.bitrate);
    return {
      ...l,
      total: mine.length,
      counts,
      size: mine.reduce((s, r) => s + (r.size ?? 0), 0),
      bitrate: rated.length ? rated.reduce((s, r) => s + (r.bitrate ?? 0), 0) / rated.length : 0,
    };
  });
  return {
    total: rows.length,
    libraries: libs.length,
    size: perLibrary.reduce((s, l) => s + l.size, 0),
    types: buckets(rows, 'type', [...MEDIA_TYPES, 'other']).filter((b) => b.key !== 'other' || b.count),
    video: buckets(rows, 'video'),
    audio: buckets(rows, 'audio'),
    containers: buckets(rows, 'container'),
    resolutions: buckets(rows, 'res', RESOLUTIONS),
    hdr: buckets(rows, 'hdr', ['hdr10', 'hdr10+', 'dv', 'hlg']),
    noSubs: share(rows.filter((r) => inBucket(r, 'noSubs', 'yes')).length, videoRows),
    oneLang: share(rows.filter((r) => inBucket(r, 'oneLang', 'yes')).length, videoRows),
    perLibrary,
  };
}

// ---- Export ----

export const CSV_COLUMNS = ['library', 'type', 'name', 'path', 'container', 'video', 'width', 'height', 'resolution', 'hdr', 'audio', 'audioLanguages', 'subtitles', 'size', 'bitrate'] as const;

function cell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // A leading = + - @ (or a tab or CR before one, which some apps strip) would run as a formula in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

// RFC 4180 with a BOM, so spreadsheet apps read the accents as UTF-8.
export function toCsv(rows: ScanRow[], libName: (id: string) => string): string {
  const lines = rows.map((r) =>
    [libName(r.lib), r.type, r.name, r.path, r.container, r.video, r.width, r.height, r.res, r.hdr, r.audio?.join(' '), r.langs, r.subs, r.size, r.bitrate].map(cell).join(','),
  );
  return `﻿${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}
