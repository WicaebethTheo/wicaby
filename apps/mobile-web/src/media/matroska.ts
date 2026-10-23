// A Matroska / WebM demuxer for playback: the header (info, tracks, the cue index), then the frames cluster by
// cluster from any cue point. It reads only what playback needs, in order, through a Cursor (media/source.ts):
// from a file served as is, or from a stream the server produces. Lacing (Xiph, EBML, fixed), header stripping,
// unknown-size segments and clusters (live muxing) and Dolby Vision's block addition mapping are handled.
import type { ByteSource, Cursor } from './source';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  BlockAdditionMapping: 0x41e4,
  BlockAddIDType: 0x41e7,
  BlockAddIDExtraData: 0x41ed,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

// Elements that end an unknown-size cluster (the next top-level element of the segment).
const TOP_LEVEL = new Set<number>([ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments, ID.SeekHead, ID.Info, ID.Tracks]);
const UNKNOWN = -1;

export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface Track {
  number: number;
  kind: TrackKind;
  codec: string;
  priv?: Uint8Array;
  name?: string;
  language?: string;
  isDefault: boolean;
  isForced: boolean;
  // Nanoseconds per frame, when the muxer wrote it.
  defaultDuration?: number;
  codecDelayNs?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  // Header stripping: bytes removed from every frame, put back on read.
  stripped?: Uint8Array;
  // zlib-compressed frames: subtitle tracks only (mkvmerge's default for PGS), inflated by their reader.
  zlib?: boolean;
  // Dolby Vision configuration record: its box type (dvcC up to profile 7, dvvC above) and payload.
  dolbyVision?: { box: 'dvcC' | 'dvvC'; data: Uint8Array };
}

export interface CuePoint {
  timeMs: number;
  // Absolute offset of the cluster in the file.
  offset: number;
}

export interface Frame {
  track: number;
  // Presentation time in milliseconds of the file's timeline.
  ptsMs: number;
  // From the block's duration (BlockGroup), when given.
  durationMs?: number;
  key: boolean;
  data: Uint8Array;
}

export interface Header {
  timecodeScale: number;
  durationMs: number | undefined;
  tracks: Track[];
  cues: CuePoint[];
  // Absolute offset of the segment's payload (positions in SeekHead and Cues count from it).
  segmentStart: number;
  // Where the first cluster starts.
  firstCluster: number;
  // A stream (read once): the cursor stays open on the first cluster, whose id and size are already read.
  resume?: { cursor: Cursor; size: number };
}

// ---- EBML primitives ----

function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  throw new Error('matroska: invalid variable-size integer');
}

async function readId(c: Cursor): Promise<number | null> {
  const a = await c.read(1);
  if (!a.length) return null;
  const len = vintLength(a[0]);
  if (len > 4) throw new Error('matroska: invalid element id');
  let id = a[0];
  if (len > 1) {
    const rest = await c.read(len - 1);
    if (rest.length < len - 1) return null;
    for (const b of rest) id = id * 256 + b;
  }
  return id;
}

async function readSize(c: Cursor): Promise<number> {
  const a = await c.read(1);
  if (!a.length) throw new Error('matroska: truncated');
  const len = vintLength(a[0]);
  let v = a[0] & (0xff >> len);
  let allOnes = v === 0xff >> len;
  if (len > 1) {
    const rest = await c.read(len - 1);
    for (const b of rest) {
      v = v * 256 + b;
      if (b !== 0xff) allOnes = false;
    }
  }
  return allOnes ? UNKNOWN : v;
}

function uint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function float(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : b.length === 8 ? dv.getFloat64(0) : 0;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, '');

// The children of a master element held in memory.
function* children(b: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  let i = 0;
  while (i < b.length) {
    const idLen = vintLength(b[i]);
    let id = 0;
    for (let k = 0; k < idLen; k++) id = id * 256 + b[i + k];
    i += idLen;
    if (i >= b.length) return;
    const sLen = vintLength(b[i]);
    let size = b[i] & (0xff >> sLen);
    for (let k = 1; k < sLen; k++) size = size * 256 + b[i + k];
    i += sLen;
    const data = b.subarray(i, i + size);
    i += size;
    yield { id, data };
  }
}

// ---- Header ----

function parseTracks(b: Uint8Array): Track[] {
  const out: Track[] = [];
  for (const e of children(b)) {
    if (e.id !== ID.TrackEntry) continue;
    const t: Partial<Track> & { type?: number; enabled?: boolean } = { isDefault: true, isForced: false, enabled: true };
    for (const f of children(e.data)) {
      switch (f.id) {
        case ID.TrackNumber: t.number = uint(f.data); break;
        case ID.TrackType: t.type = uint(f.data); break;
        case ID.FlagEnabled: t.enabled = uint(f.data) !== 0; break;
        case ID.FlagDefault: t.isDefault = uint(f.data) !== 0; break;
        case ID.FlagForced: t.isForced = uint(f.data) !== 0; break;
        case ID.DefaultDuration: t.defaultDuration = uint(f.data); break;
        case ID.Name: t.name = text(f.data); break;
        case ID.Language: t.language ??= text(f.data); break;
        case ID.LanguageBCP47: t.language = text(f.data); break;
        case ID.CodecID: t.codec = text(f.data); break;
        case ID.CodecPrivate: t.priv = f.data.slice(); break;
        case ID.CodecDelay: t.codecDelayNs = uint(f.data); break;
        case ID.Video:
          for (const v of children(f.data)) {
            if (v.id === ID.PixelWidth) t.width = uint(v.data);
            else if (v.id === ID.PixelHeight) t.height = uint(v.data);
          }
          break;
        case ID.Audio:
          for (const a of children(f.data)) {
            if (a.id === ID.SamplingFrequency) t.sampleRate = float(a.data);
            else if (a.id === ID.Channels) t.channels = uint(a.data);
            else if (a.id === ID.BitDepth) t.bitDepth = uint(a.data);
          }
          break;
        case ID.ContentEncodings:
          for (const enc of children(f.data))
            for (const comp of children(enc.data))
              if (comp.id === ID.ContentCompression) {
                let algo = 0;
                let settings: Uint8Array | undefined;
                for (const c of children(comp.data)) {
                  if (c.id === ID.ContentCompAlgo) algo = uint(c.data);
                  else if (c.id === ID.ContentCompSettings) settings = c.data.slice();
                }
                // 3 = header stripping; zlib (0) only on subtitle tracks (marked below).
                if (algo === 3) t.stripped = settings;
                else if (algo === 0) t.zlib = true;
                else t.codec = `${t.codec ?? ''}+compressed`;
              }
          break;
        case ID.BlockAdditionMapping: {
          let type = 0;
          let extra: Uint8Array | undefined;
          for (const m of children(f.data)) {
            if (m.id === ID.BlockAddIDType) type = uint(m.data);
            else if (m.id === ID.BlockAddIDExtraData) extra = m.data.slice();
          }
          // 'dvcC' or 'dvvC'
          if ((type === 0x64766343 || type === 0x64767643) && extra) t.dolbyVision = { box: type === 0x64766343 ? 'dvcC' : 'dvvC', data: extra };
          break;
        }
      }
    }
    const kind: TrackKind | null = t.type === 1 ? 'video' : t.type === 2 ? 'audio' : t.type === 17 ? 'subtitle' : null;
    if (t.zlib && kind !== 'subtitle') t.codec = `${t.codec ?? ''}+compressed`;
    if (kind && t.number !== undefined && t.codec && t.enabled) out.push({ ...(t as Track), kind });
  }
  return out;
}

function parseCues(b: Uint8Array, segmentStart: number, scale: number, videoTrack: number | undefined): CuePoint[] {
  const out: CuePoint[] = [];
  for (const p of children(b)) {
    if (p.id !== ID.CuePoint) continue;
    let time = -1;
    for (const f of children(p.data)) {
      if (f.id === ID.CueTime) time = uint(f.data);
      else if (f.id === ID.CueTrackPositions) {
        let track = 0;
        let pos = -1;
        for (const g of children(f.data)) {
          if (g.id === ID.CueTrack) track = uint(g.data);
          else if (g.id === ID.CueClusterPosition) pos = uint(g.data);
        }
        if (time >= 0 && pos >= 0 && (videoTrack === undefined || track === videoTrack)) out.push({ timeMs: (time * scale) / 1e6, offset: segmentStart + pos });
      }
    }
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

export async function readHeader(src: ByteSource): Promise<Header> {
  const c = src.open(0);
  let keep = false;
  try {
    if ((await readId(c)) !== ID.EBML) throw new Error('matroska: not an EBML file');
    await c.skip(await readSize(c));
    if ((await readId(c)) !== ID.Segment) throw new Error('matroska: no segment');
    await readSize(c);
    const segmentStart = c.offset;
    let scale = 1_000_000;
    let durationMs: number | undefined;
    let tracks: Track[] | null = null;
    let cuesAt: number | null = null;
    let cues: CuePoint[] = [];
    let firstCluster = -1;
    let firstSize = 0;
    // Up to the first cluster: SeekHead (where the cues are), Info and Tracks; anything else is skipped.
    for (;;) {
      const at = c.offset;
      const id = await readId(c);
      if (id === null) break;
      const size = await readSize(c);
      if (id === ID.Cluster) {
        firstCluster = at;
        firstSize = size;
        break;
      }
      if (size === UNKNOWN) throw new Error('matroska: unknown-size element before the clusters');
      if (id === ID.Info || id === ID.Tracks || id === ID.SeekHead || id === ID.Cues) {
        const data = await c.read(size);
        if (id === ID.Info)
          for (const f of children(data)) {
            if (f.id === ID.TimecodeScale) scale = uint(f.data);
            else if (f.id === ID.Duration) durationMs = (float(f.data) * scale) / 1e6;
          }
        else if (id === ID.Tracks) tracks = parseTracks(data);
        else if (id === ID.SeekHead)
          for (const s of children(data)) {
            if (s.id !== ID.Seek) continue;
            let sid = 0;
            let pos = -1;
            for (const f of children(s.data)) {
              if (f.id === ID.SeekID) sid = uint(f.data);
              else if (f.id === ID.SeekPosition) pos = uint(f.data);
            }
            if (sid === ID.Cues && pos >= 0) cuesAt = segmentStart + pos;
          }
        else cues = parseCues(data, segmentStart, scale, undefined);
      } else await c.skip(size);
    }
    if (!tracks) throw new Error('matroska: no tracks');
    const video = tracks.find((t) => t.kind === 'video')?.number;
    // The cue index, usually at the end of the file: one range read.
    if (!cues.length && cuesAt !== null && src.seekable) {
      const cc = src.open(cuesAt);
      try {
        if ((await readId(cc)) === ID.Cues) {
          const size = await readSize(cc);
          if (size > 0 && size < 64 * 1024 * 1024) cues = parseCues(await cc.read(size), segmentStart, scale, video);
        }
      } finally {
        cc.close();
      }
    }
    if (firstCluster < 0) throw new Error('matroska: no clusters');
    keep = !src.seekable;
    return { timecodeScale: scale, durationMs, tracks, cues, segmentStart, firstCluster, resume: keep ? { cursor: c, size: firstSize } : undefined };
  } finally {
    if (!keep) c.close();
  }
}

// ---- Frames ----

// The frames of a block, unlaced.
function unlace(payload: Uint8Array, lacing: number): Uint8Array[] {
  if (lacing === 0) return [payload];
  const count = payload[0] + 1;
  let i = 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph: each size as a run of 255s plus a final byte.
    for (let k = 0; k < count - 1; k++) {
      let s = 0;
      let b: number;
      do {
        b = payload[i++];
        s += b;
      } while (b === 255);
      sizes.push(s);
    }
  } else if (lacing === 3) {
    // EBML: the first size as a vint, then signed differences.
    const read = (): [number, number] => {
      const len = vintLength(payload[i]);
      let v = payload[i] & (0xff >> len);
      for (let k = 1; k < len; k++) v = v * 256 + payload[i + k];
      i += len;
      return [v, len];
    };
    let [first] = read();
    sizes.push(first);
    for (let k = 1; k < count - 1; k++) {
      const [raw, len] = read();
      const diff = raw - (2 ** (7 * len - 1) - 1);
      first += diff;
      sizes.push(first);
    }
  } else {
    // Fixed: equal sizes.
    const each = (payload.length - 1) / count;
    for (let k = 0; k < count - 1; k++) sizes.push(each);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(payload.length - i - used);
  const out: Uint8Array[] = [];
  for (const s of sizes) {
    out.push(payload.subarray(i, i + s));
    i += s;
  }
  return out;
}

function parseBlock(b: Uint8Array, clusterTime: number, scale: number, simple: boolean, tracks: Map<number, Track>, durationTicks: number | undefined, referenced: boolean): Frame[] {
  const len = vintLength(b[0]);
  let track = b[0] & (0xff >> len);
  for (let k = 1; k < len; k++) track = track * 256 + b[k];
  const t = tracks.get(track);
  if (!t) return [];
  // Signed 16-bit offset from the cluster's time.
  const rel = ((b[len] << 24) >> 16) | b[len + 1];
  const flags = b[len + 2];
  const key = simple ? (flags & 0x80) !== 0 : !referenced;
  const lacing = (flags >> 1) & 3;
  const frames = unlace(b.subarray(len + 3), lacing);
  const ptsMs = ((clusterTime + rel) * scale) / 1e6;
  const total = durationTicks !== undefined ? (durationTicks * scale) / 1e6 : undefined;
  const each = total !== undefined ? total / frames.length : t.defaultDuration ? t.defaultDuration / 1e6 : undefined;
  return frames.map((f, k) => {
    let data = f;
    if (t.stripped?.length) {
      data = new Uint8Array(t.stripped.length + f.length);
      data.set(t.stripped);
      data.set(f, t.stripped.length);
    }
    return { track, ptsMs: each !== undefined ? ptsMs + k * each : ptsMs, durationMs: each, key, data };
  });
}

// Frames from the cluster at [offset] on, in file order. Stops at the end of the data or when the reader stops
// pulling. Every cluster's frames come together, as one array.
export async function* clusters(src: ByteSource, header: Header, offset: number): AsyncGenerator<Frame[]> {
  const byNumber = new Map(header.tracks.map((t) => [t.number, t]));
  // A stream goes on from where the header stopped, inside the first cluster's header.
  const resume = src.seekable ? undefined : header.resume;
  header.resume = undefined;
  const c = resume?.cursor ?? src.open(offset);
  let first: { id: number; size: number } | null = resume ? { id: ID.Cluster, size: resume.size } : null;
  try {
    let pending: number | null = null;
    for (;;) {
      let id: number | null;
      let size: number;
      if (first) {
        ({ id, size } = first);
        first = null;
      } else {
        id = pending ?? (await readId(c));
        pending = null;
        if (id === null) return;
        size = await readSize(c);
      }
      if (id !== ID.Cluster) {
        if (size === UNKNOWN) continue; // an unknown-size wrapper: read into it
        await c.skip(size);
        continue;
      }
      const frames: Frame[] = [];
      let time = 0;
      const end = size === UNKNOWN ? Infinity : c.offset + size;
      while (c.offset < end) {
        const cid = await readId(c);
        if (cid === null) break;
        if (size === UNKNOWN && TOP_LEVEL.has(cid)) {
          pending = cid;
          break;
        }
        const csize = await readSize(c);
        if (cid === ID.Timecode) time = uint(await c.read(csize));
        else if (cid === ID.SimpleBlock) frames.push(...parseBlock(await c.read(csize), time, header.timecodeScale, true, byNumber, undefined, false));
        else if (cid === ID.BlockGroup) {
          let block: Uint8Array | undefined;
          let duration: number | undefined;
          let referenced = false;
          for (const g of children(await c.read(csize))) {
            if (g.id === ID.Block) block = g.data;
            else if (g.id === ID.BlockDuration) duration = uint(g.data);
            else if (g.id === ID.ReferenceBlock) referenced = true;
          }
          if (block) frames.push(...parseBlock(block, time, header.timecodeScale, false, byNumber, duration, referenced));
        } else await c.skip(csize);
      }
      yield frames;
    }
  } finally {
    c.close();
  }
}

// The cue point at or before [ms] (the cluster to start reading from for a seek).
export function cueBefore(cues: CuePoint[], ms: number): CuePoint | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  let found: CuePoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].timeMs <= ms) {
      found = cues[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
