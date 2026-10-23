// Fragmented MP4 writing (ISO/IEC 14496-12): one initialization segment per track (ftyp + moov with a single trak
// and mvex), then media fragments (moof + mdat), as Media Source Extensions take them. Signed composition offsets
// (trun version 1) carry B-frame reordering.

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export const u8 = (v: number) => Uint8Array.of(v & 0xff);
export const u16 = (v: number) => Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
export const u24 = (v: number) => Uint8Array.of((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
export const u32 = (v: number) => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
export function u64(v: number): Uint8Array {
  const hi = Math.floor(v / 2 ** 32);
  return concat([u32(hi), u32(v >>> 0)]);
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n: number) => new Uint8Array(n);

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}

export function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...parts);
}

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export interface TrackInit {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  // The codec's sample entry box (avc1, hvc1, av01, mp4a, ac-3, ec-3, Opus, fLaC…).
  sampleEntry: Uint8Array;
  width?: number;
  height?: number;
  language?: string;
}

function language(code: string | undefined): Uint8Array {
  const c = /^[a-z]{3}$/.test(code ?? '') ? code! : 'und';
  const v = ((c.charCodeAt(0) - 0x60) << 10) | ((c.charCodeAt(1) - 0x60) << 5) | (c.charCodeAt(2) - 0x60);
  return u16(v);
}

export function initSegment(t: TrackInit): Uint8Array {
  const video = t.kind === 'video';
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso6'), ascii('mp41'), ascii('dash'));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(t.id + 1));
  const tkhd = fullBox(
    'tkhd', 0, 3,
    u32(0), u32(0), u32(t.id), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), MATRIX,
    u32((t.width ?? 0) << 16), u32((t.height ?? 0) << 16),
  );
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), language(t.language), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(video ? 'vide' : 'soun'), zeros(12), ascii(video ? 'Video' : 'Sound'), u8(0));
  const header = video ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), t.sampleEntry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', header, dinf, stbl)));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

export interface Sample {
  data: Uint8Array;
  duration: number;
  // Presentation minus decode time, in the track's timescale (may be negative).
  cto: number;
  key: boolean;
}

let sequence = 1;

// One fragment: the samples of one track from [baseDts] (decode time, the track's timescale).
export function fragment(trackId: number, baseDts: number, samples: Sample[]): Uint8Array {
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const entries = samples.map((s) =>
    concat([u32(s.duration), u32(s.data.length), u32(s.key ? 0x02000000 : 0x01010000), u32(s.cto | 0)]),
  );
  const build = (dataOffset: number) =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x020000, u32(trackId)),
        fullBox('tfdt', 1, 0, u64(baseDts)),
        fullBox('trun', 1, trunFlags, u32(samples.length), u32(dataOffset), ...entries),
      ),
    );
  // The data offset counts from the moof's first byte to the samples (past the mdat header).
  const size = build(0).length;
  const moof = build(size + 8);
  sequence++;
  return concat([moof, box('mdat', ...samples.map((s) => s.data))]);
}

// Sample entry scaffolding shared by the codecs (media/codecs.ts).
export function visualEntry(type: string, width: number, height: number, ...config: Uint8Array[]): Uint8Array {
  return box(
    type,
    zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
    ...config,
  );
}

export function audioEntry(type: string, channels: number, sampleRate: number, ...config: Uint8Array[]): Uint8Array {
  return box(type, zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate > 65535 ? 0 : sampleRate << 16), ...config);
}
