// Blu-ray image subtitles (PGS, Matroska's S_HDMV/PGS) decoded on the phone, so the server never burns them into
// a transcode of the whole film. A Matroska block holds segments without the "PG" header of the .sup file: type,
// size, payload. A display set (PCS, WDS, PDS, ODS…, END) either shows composition objects (bitmaps run-length
// coded on a 256-colour YCbCr palette) at positions on the video frame, or clears the screen. Objects and palettes
// stay defined for the epoch, so a later display set may show one again with only a PCS.
// The bitmaps stay run-length coded until shown (drawPgs): a film's thousand pictures would be tens of MB decoded.

export interface PgsPart {
  x: number;
  y: number;
  width: number;
  height: number;
  rle: Uint8Array;
}

export interface PgsPicture {
  // The video frame the positions count in (1920 × 1080 for a Blu-ray).
  frameWidth: number;
  frameHeight: number;
  parts: PgsPart[];
  // RGBA, premultiplied for nothing: straight alpha, as ImageData takes it.
  palette: Uint32Array;
}

export type PgsEvent = { ms: number; picture: PgsPicture } | { ms: number; picture: null };

const PDS = 0x14;
const ODS = 0x15;
const PCS = 0x16;
const END = 0x80;

interface PcsObject {
  id: number;
  x: number;
  y: number;
}

interface PgsObject {
  width: number;
  height: number;
  // Fragments while the object spans several segments (first and last flags).
  chunks: Uint8Array[];
  length: number;
  rle?: Uint8Array;
}

const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

// BT.709 for HD frames, BT.601 below, limited range, as Blu-ray players convert.
function rgba(y: number, cr: number, cb: number, a: number, hd: boolean): number {
  const yy = 1.164 * (y - 16);
  const r = hd ? yy + 1.793 * (cr - 128) : yy + 1.596 * (cr - 128);
  const g = hd ? yy - 0.213 * (cb - 128) - 0.533 * (cr - 128) : yy - 0.392 * (cb - 128) - 0.813 * (cr - 128);
  const b = hd ? yy + 2.112 * (cb - 128) : yy + 2.017 * (cb - 128);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  // Little-endian Uint32 over ImageData's bytes: R in the low byte.
  return ((a << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}

export class PgsDecoder {
  private palettes = new Map<number, Uint32Array>();
  private objects = new Map<number, PgsObject>();
  private frame = { width: 1920, height: 1080 };
  private pending: { ms: number; paletteId: number; objects: PcsObject[] } | null = null;

  // The segments of one block; an event when they end a display set.
  push(data: Uint8Array, ms: number): PgsEvent | null {
    let event: PgsEvent | null = null;
    for (let i = 0; i + 3 <= data.length; ) {
      const type = data[i];
      const size = u16(data, i + 1);
      const seg = data.subarray(i + 3, i + 3 + size);
      i += 3 + size;
      if (seg.length < size) break;
      if (type === PCS) this.composition(seg, ms);
      else if (type === PDS) this.palette(seg);
      else if (type === ODS) this.object(seg);
      else if (type === END) event = this.end() ?? event;
    }
    return event;
  }

  private composition(s: Uint8Array, ms: number): void {
    if (s.length < 11) return;
    this.frame = { width: u16(s, 0), height: u16(s, 2) };
    // Epoch start: every object and palette is defined again.
    if (s[7] & 0x80) {
      this.palettes.clear();
      this.objects.clear();
    }
    const paletteId = s[9];
    const count = s[10];
    const objects: PcsObject[] = [];
    for (let i = 0, p = 11; i < count && p + 8 <= s.length; i++) {
      const cropped = s[p + 3] & 0x80;
      objects.push({ id: u16(s, p), x: u16(s, p + 4), y: u16(s, p + 6) });
      p += cropped ? 16 : 8;
    }
    this.pending = { ms, paletteId, objects };
  }

  private palette(s: Uint8Array): void {
    if (s.length < 2) return;
    const id = s[0];
    // A palette update keeps the entries it does not name.
    const old = this.palettes.get(id);
    const pal = old ? old.slice() : new Uint32Array(256);
    const hd = this.frame.height >= 720;
    for (let p = 2; p + 5 <= s.length; p += 5) pal[s[p]] = rgba(s[p + 1], s[p + 2], s[p + 3], s[p + 4], hd);
    this.palettes.set(id, pal);
  }

  private object(s: Uint8Array): void {
    if (s.length < 4) return;
    const id = u16(s, 0);
    const flags = s[3];
    if (flags & 0x80) {
      if (s.length < 11) return;
      const o: PgsObject = { width: u16(s, 7), height: u16(s, 9), chunks: [s.slice(11)], length: s.length - 11 };
      this.objects.set(id, o);
    } else {
      const o = this.objects.get(id);
      if (!o || o.rle) return;
      o.chunks.push(s.slice(4));
      o.length += s.length - 4;
    }
    if (flags & 0x40) {
      const o = this.objects.get(id)!;
      const rle = new Uint8Array(o.length);
      let at = 0;
      for (const c of o.chunks) rle.set(c, (at += c.length) - c.length);
      o.rle = rle;
      o.chunks = [];
    }
  }

  private end(): PgsEvent | null {
    const set = this.pending;
    this.pending = null;
    if (!set) return null;
    const palette = this.palettes.get(set.paletteId);
    const parts: PgsPart[] = [];
    for (const c of set.objects) {
      const o = this.objects.get(c.id);
      if (o?.rle && o.width && o.height) parts.push({ x: c.x, y: c.y, width: o.width, height: o.height, rle: o.rle });
    }
    if (!parts.length || !palette) return { ms: set.ms, picture: null };
    return { ms: set.ms, picture: { frameWidth: this.frame.width, frameHeight: this.frame.height, parts, palette } };
  }
}

// One part's bitmap, run-length decoded: RGBA pixels, row after row.
export function decodePgs(part: PgsPart, palette: Uint32Array): Uint32Array {
  const px = new Uint32Array(part.width * part.height);
  const { rle, width } = part;
  let x = 0;
  let y = 0;
  const run = (n: number, colour: number) => {
    const v = palette[colour];
    const start = y * width + x;
    const end = Math.min(start + n, y * width + width, px.length);
    if (v) px.fill(v, start, end);
    x += n;
  };
  for (let i = 0; i < rle.length && y < part.height; ) {
    const b = rle[i++];
    if (b) {
      run(1, b);
      continue;
    }
    const n = rle[i++];
    if (n === 0) {
      // End of the line.
      x = 0;
      y++;
    } else if ((n & 0xc0) === 0x00) run(n & 0x3f, 0);
    else if ((n & 0xc0) === 0x40) run(((n & 0x3f) << 8) | rle[i++], 0);
    else if ((n & 0xc0) === 0x80) run(n & 0x3f, rle[i++]);
    else {
      const len = ((n & 0x3f) << 8) | rle[i++];
      run(len, rle[i++]);
    }
  }
  return px;
}

// Into a canvas of its size.
export function drawPgs(canvas: HTMLCanvasElement, part: PgsPart, palette: Uint32Array): void {
  canvas.width = part.width;
  canvas.height = part.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const px = decodePgs(part, palette);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), part.width, part.height), 0, 0);
}

// zlib, as mkvmerge stores PGS and VobSub tracks by default.
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
