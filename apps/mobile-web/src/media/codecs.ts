// What each Matroska codec becomes in MP4 for Safari: its sample entry (with the decoder configuration box), its
// RFC 6381 codec string for MediaSource.isTypeSupported / addSourceBuffer, and, for audio, the duration of a frame
// in samples so timestamps stay exact. Nothing is decoded: frames are copied as they are.
import { audioEntry, box, concat, fullBox, u16, u24, u32, u8, visualEntry } from './mp4';
import type { Track } from './matroska';

export interface Mapped {
  // The MP4 sample entry box.
  entry: Uint8Array;
  // For addSourceBuffer: 'video/mp4; codecs="hvc1.2.4.L153.B0"'.
  mime: string;
  timescale: number;
  // Audio: the duration of one frame (one MKV frame) in samples, from its bytes; undefined for video.
  frameSamples?: (frame: Uint8Array) => number;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const dec2 = (n: number) => n.toString().padStart(2, '0');

class Bits {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3] ?? 0;
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
}

class BitWriter {
  private bits: number[] = [];
  write(v: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
    return out;
  }
}

// ---- Video ----

function avc(t: Track): Mapped {
  const c = t.priv!;
  return {
    entry: visualEntry('avc1', t.width ?? 0, t.height ?? 0, box('avcC', c)),
    mime: `video/mp4; codecs="avc1.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}"`,
    timescale: 90000,
  };
}

function reverseBits32(v: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) r = r * 2 + ((v >>> i) & 1);
  return r;
}

export function hevcCodec(c: Uint8Array, prefix = 'hvc1'): string {
  const space = ['', 'A', 'B', 'C'][c[1] >> 6];
  const tier = (c[1] >> 5) & 1 ? 'H' : 'L';
  const profile = c[1] & 0x1f;
  const compat = reverseBits32(((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0);
  const constraints = Array.from(c.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return [`${prefix}.${space}${profile}`, compat.toString(16), `${tier}${c[12]}`, ...constraints.map((b) => b.toString(16).toUpperCase())].join('.');
}

function hevc(t: Track): Mapped {
  const c = t.priv!;
  const dv = t.dolbyVision;
  const config = [box('hvcC', c)];
  let mime = `video/mp4; codecs="${hevcCodec(c)}"`;
  let type = 'hvc1';
  if (dv) {
    const profile = dv.data[2] >> 1;
    const level = ((dv.data[2] & 1) << 5) | (dv.data[3] >> 3);
    const compat = dv.data[4] >> 4;
    // Profile 5 (Dolby Vision only): a dvh1 track. Profile 8 (HDR10 / SDR / HLG base): an HEVC track that carries
    // the Dolby Vision configuration, played as Dolby Vision where supported. Profile 7's enhancement layer
    // is not carried: its HDR10 base layer plays.
    if (profile === 5) {
      type = 'dvh1';
      mime = `video/mp4; codecs="dvh1.${dec2(profile)}.${dec2(level)}"`;
      config.push(box(dv.box, dv.data));
    } else if (profile === 8 && compat !== 0) config.push(box(dv.box, dv.data));
  }
  return { entry: visualEntry(type, t.width ?? 0, t.height ?? 0, ...config), mime, timescale: 90000 };
}

function av1(t: Track): Mapped {
  const c = t.priv!;
  const profile = c[1] >> 5;
  const level = c[1] & 0x1f;
  const tier = c[2] >> 7 ? 'H' : 'M';
  const depth = (c[2] >> 6) & 1 ? ((c[2] >> 5) & 1 ? 12 : 10) : 8;
  return {
    entry: visualEntry('av01', t.width ?? 0, t.height ?? 0, box('av1C', c)),
    mime: `video/mp4; codecs="av01.${profile}.${dec2(level)}${tier}.${dec2(depth)}"`,
    timescale: 90000,
  };
}

// ---- Audio ----

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  // Four-byte size: valid for any length below 2^28.
  return concat([u8(tag), Uint8Array.of(0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f), body]);
}

function esds(objectType: number, dsi?: Uint8Array): Uint8Array {
  const config = descriptor(0x04, u8(objectType), u8(0x15), u24(0), u32(0), u32(0), ...(dsi ? [descriptor(0x05, dsi)] : []));
  return fullBox('esds', 0, 0, descriptor(0x03, u16(1), u8(0), config, descriptor(0x06, u8(2))));
}

function aac(t: Track): Mapped {
  let asc = t.priv;
  if (!asc?.length) {
    // Old A_AAC/MPEG4/… ids without a config: AAC-LC at the track's rate and channel count.
    const rate = Math.max(0, AAC_RATES.indexOf(Math.round(t.sampleRate ?? 48000)));
    asc = new BitWriter().write(2, 5).write(rate, 4).write(t.channels ?? 2, 4).write(0, 3).bytes();
  }
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  const rate = Math.round(t.sampleRate ?? 48000);
  return {
    entry: audioEntry('mp4a', t.channels ?? 2, rate, esds(0x40, asc)),
    mime: `audio/mp4; codecs="mp4a.40.${aot}"`,
    timescale: rate,
    frameSamples: () => 1024,
  };
}

function mp3(t: Track): Mapped {
  const rate = Math.round(t.sampleRate ?? 44100);
  return {
    entry: audioEntry('mp4a', t.channels ?? 2, rate, esds(0x6b)),
    mime: 'audio/mp4; codecs="mp4a.6b"',
    timescale: rate,
    // MPEG-1 Layer III frames hold 1152 samples, MPEG-2/2.5 ones 576.
    frameSamples: (f) => ((f[1] >> 3) & 3) === 3 ? 1152 : 576,
  };
}

const AC3_RATES = [48000, 44100, 32000];

function ac3(t: Track, first: Uint8Array): Mapped {
  const b = new Bits(first);
  b.skip(16 + 16); // syncword, crc1
  const fscod = b.read(2);
  const frmsizecod = b.read(6);
  const bsid = b.read(5);
  const bsmod = b.read(3);
  const acmod = b.read(3);
  if ((acmod & 1) && acmod !== 1) b.skip(2);
  if (acmod & 4) b.skip(2);
  if (acmod === 2) b.skip(2);
  const lfeon = b.read(1);
  const dac3 = new BitWriter().write(fscod, 2).write(bsid, 5).write(bsmod, 3).write(acmod, 3).write(lfeon, 1).write(frmsizecod >> 1, 5).write(0, 5).bytes();
  const rate = AC3_RATES[fscod] ?? 48000;
  const channels = [2, 1, 2, 3, 3, 4, 4, 5][acmod] + lfeon;
  return { entry: audioEntry('ac-3', channels, rate, box('dac3', dac3)), mime: 'audio/mp4; codecs="ac-3"', timescale: rate, frameSamples: () => 1536 };
}

interface Eac3Frame {
  strmtyp: number;
  substreamid: number;
  size: number;
  fscod: number;
  blocks: number;
  acmod: number;
  lfeon: number;
  bsid: number;
  chanmap?: number;
}

function eac3Frames(data: Uint8Array): Eac3Frame[] {
  const out: Eac3Frame[] = [];
  let i = 0;
  while (i + 6 <= data.length && data[i] === 0x0b && data[i + 1] === 0x77) {
    const b = new Bits(data.subarray(i + 2));
    const strmtyp = b.read(2);
    const substreamid = b.read(3);
    const size = (b.read(11) + 1) * 2;
    const fscod = b.read(2);
    const blocks = fscod === 3 ? (b.skip(2), 6) : [1, 2, 3, 6][b.read(2)];
    const acmod = b.read(3);
    const lfeon = b.read(1);
    const bsid = b.read(5);
    b.skip(5); // dialnorm
    if (b.read(1)) b.skip(8); // compr
    if (acmod === 0) {
      b.skip(5);
      if (b.read(1)) b.skip(8);
    }
    let chanmap: number | undefined;
    if (strmtyp === 1 && b.read(1)) chanmap = b.read(16);
    out.push({ strmtyp, substreamid, size, fscod, blocks, acmod, lfeon, bsid, chanmap });
    i += size;
  }
  return out;
}

function eac3(t: Track, first: Uint8Array): Mapped {
  const frames = eac3Frames(first);
  const independent = frames.filter((f) => f.strmtyp !== 1);
  const main = independent[0];
  if (!main) throw new Error('eac3: no independent substream');
  const rate = AC3_RATES[main.fscod] ?? 48000;
  const samples = main.blocks * 256;
  const bytes = frames.reduce((a, f) => a + f.size, 0);
  const w = new BitWriter().write(Math.round((bytes * 8 * rate) / samples / 1000), 13).write(independent.length - 1, 3);
  let channels = 0;
  for (const ind of independent) {
    const deps = frames.filter((f) => f.strmtyp === 1 && f.substreamid === ind.substreamid);
    w.write(ind.fscod, 2).write(ind.bsid, 5).write(0, 1).write(0, 1).write(0, 3).write(ind.acmod, 3).write(ind.lfeon, 1).write(0, 3).write(deps.length, 4);
    let loc = 0;
    for (const d of deps) loc |= ((d.chanmap ?? 0) >> 5) & 0x1f;
    if (deps.length) w.write(loc, 9);
    else w.write(0, 1);
    channels += [2, 1, 2, 3, 3, 4, 4, 5][ind.acmod] + ind.lfeon;
    // Dependent substreams add channels (7.1: two more surrounds).
    channels += deps.length ? 2 : 0;
  }
  return {
    entry: audioEntry('ec-3', Math.min(channels, 8), rate, box('dec3', w.bytes())),
    mime: 'audio/mp4; codecs="ec-3"',
    timescale: rate,
    // A frame's samples: the independent substream 0's blocks.
    frameSamples: (f) => {
      let n = 0;
      for (const e of eac3Frames(f)) if (e.strmtyp !== 1 && e.substreamid === 0) n += e.blocks * 256;
      return n || 1536;
    },
  };
}

const OPUS_MS = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20];

function opus(t: Track): Mapped {
  const h = t.priv!;
  // OpusHead (little-endian) to dOps (big-endian).
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const channels = h[9];
  const family = h[18];
  const dops = box(
    'dOps',
    u8(0), u8(channels), u16(dv.getUint16(10, true)), u32(dv.getUint32(12, true)), u16(dv.getInt16(16, true) & 0xffff), u8(family),
    ...(family !== 0 ? [h.subarray(19, 21 + channels)] : []),
  );
  return {
    entry: audioEntry('Opus', channels, 48000, dops),
    mime: 'audio/mp4; codecs="opus"',
    timescale: 48000,
    frameSamples: (f) => {
      const toc = f[0];
      const count = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? f[1] & 0x3f : 2;
      return OPUS_MS[toc >> 3] * 48 * count;
    },
  };
}

function flac(t: Track): Mapped {
  const p = t.priv!;
  // CodecPrivate: "fLaC", then metadata blocks; dfLa keeps the blocks, the last one flagged as last.
  const blocks = p.subarray(4).slice();
  let i = 0;
  let last = 0;
  while (i + 4 <= blocks.length) {
    last = i;
    blocks[i] &= 0x7f;
    i += 4 + ((blocks[i + 1] << 16) | (blocks[i + 2] << 8) | blocks[i + 3]);
  }
  blocks[last] |= 0x80;
  const info = blocks.subarray(4);
  const minBlock = (info[0] << 8) | info[1];
  const maxBlock = (info[2] << 8) | info[3];
  const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const channels = ((info[12] >> 1) & 7) + 1;
  return {
    entry: audioEntry('fLaC', channels, rate, fullBox('dfLa', 0, 0, blocks)),
    mime: 'audio/mp4; codecs="flac"',
    timescale: rate,
    frameSamples: (f) => {
      if (minBlock === maxBlock) return maxBlock;
      const code = f[2] >> 4;
      return code === 1 ? 192 : code >= 2 && code <= 5 ? 576 << (code - 2) : code >= 8 ? 256 << (code - 8) : maxBlock;
    },
  };
}

// The MP4 form of [t], from its first frame when the configuration lives in the bitstream (AC-3, E-AC-3).
// null: a codec this player does not carry (the server converts it).
export function mapTrack(t: Track, first: Uint8Array | undefined): Mapped | null {
  const id = t.codec;
  try {
    if (id === 'V_MPEG4/ISO/AVC' && t.priv) return avc(t);
    if (id === 'V_MPEGH/ISO/HEVC' && t.priv) return hevc(t);
    if (id === 'V_AV1' && t.priv) return av1(t);
    if (id.startsWith('A_AAC')) return aac(t);
    if (id === 'A_MPEG/L3') return mp3(t);
    if (id === 'A_AC3' && first) return ac3(t, first);
    if (id === 'A_EAC3' && first) return eac3(t, first);
    if (id === 'A_OPUS' && t.priv) return opus(t);
    if (id === 'A_FLAC' && t.priv) return flac(t);
  } catch {
    return null;
  }
  return null;
}

// The MediaSource type of a track's codec family, before any frame is read (to choose among the audio tracks the
// device decodes); null for codecs this player does not carry.
export function familyMime(t: Track): string | null {
  const id = t.codec;
  if (id.startsWith('A_AAC')) return 'audio/mp4; codecs="mp4a.40.2"';
  if (id === 'A_MPEG/L3') return 'audio/mp4; codecs="mp4a.6b"';
  if (id === 'A_AC3') return 'audio/mp4; codecs="ac-3"';
  if (id === 'A_EAC3') return 'audio/mp4; codecs="ec-3"';
  if (id === 'A_OPUS') return 'audio/mp4; codecs="opus"';
  if (id === 'A_FLAC') return 'audio/mp4; codecs="flac"';
  return null;
}

// Codecs whose MP4 form needs the first frame's bytes.
export const needsFirstFrame = (t: Track): boolean => t.codec === 'A_AC3' || t.codec === 'A_EAC3';
