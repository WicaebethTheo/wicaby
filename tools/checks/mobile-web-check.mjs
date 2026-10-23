// Self-check for the phone web app (apps/mobile-web, docs/mobile-web.md): its Blu-ray subtitle decoder (PGS display
// sets with run-length coded pictures, a palette update, a clear, segments split over blocks, zlib as mkvmerge
// stores them) and the text subtitles it reads from Matroska blocks (SRT and ASS to the app's safe cue HTML). No
// network, no media file: the subtitles are made here.
// Run: node tools/checks/mobile-web-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const app = path.join(repo, 'apps', 'mobile-web');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-mobile-web-'));
async function load(rel) {
  const out = path.join(dir, `${path.basename(rel).replace(/\W/g, '_')}.mjs`);
  await build({ entryPoints: [path.join(app, rel)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
  return import(pathToFileURL(out).href);
}

// --- PGS ---
const { PgsDecoder, decodePgs, inflate } = await load('src/media/pgs.ts');
const W = 300;
const H = 40;
// A white border, a half-transparent grey inside and a clear stripe: runs of every length class.
const pixel = (x, y) => (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? 1 : x >= 100 && x < 180 ? 0 : 2);
function rle() {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; ) {
      const c = pixel(x, y);
      let n = 1;
      while (x + n < W && pixel(x + n, y) === c) n++;
      if (c && n < 3) for (let i = 0; i < n; i++) out.push(c);
      else if (c === 0) out.push(0, ...(n < 64 ? [n] : [0x40 | (n >> 8), n & 0xff]));
      else out.push(0, ...(n < 64 ? [0x80 | n, c] : [0xc0 | (n >> 8), n & 0xff, c]));
      x += n;
    }
    out.push(0, 0);
  }
  return Buffer.from(out);
}
const u16 = (v) => [v >> 8, v & 0xff];
const seg = (type, payload) => Buffer.concat([Buffer.from([type, ...u16(payload.length)]), payload]);
const pcs = (n, objects, epoch, paletteId = 0, paletteOnly = false) =>
  seg(0x16, Buffer.from([...u16(1920), ...u16(1080), 0x10, ...u16(n), epoch ? 0x80 : 0, paletteOnly ? 0x80 : 0, paletteId, objects.length, ...objects.flatMap(([x, y]) => [...u16(0), 0, 0, ...u16(x), ...u16(y)])]));
const pds = (id, entries) => seg(0x14, Buffer.from([id, 0, ...entries.flat()]));
const END = seg(0x80, Buffer.alloc(0));
const bitmap = rle();
const odsLen = bitmap.length + 4;
const half = bitmap.length >> 1;
const odsFirst = seg(0x15, Buffer.concat([Buffer.from([...u16(0), 0, 0x80, (odsLen >> 16) & 0xff, (odsLen >> 8) & 0xff, odsLen & 0xff, ...u16(W), ...u16(H)]), bitmap.subarray(0, half)]));
const odsLast = seg(0x15, Buffer.concat([Buffer.from([...u16(0), 0, 0x40]), bitmap.subarray(half)]));
// Colour 1 white, colour 2 dark grey at half opacity (Y, Cr, Cb, alpha).
const palette = [
  [1, 235, 128, 128, 255],
  [2, 60, 128, 128, 128],
];

const decoder = new PgsDecoder();
// The object split over two blocks, as some muxers write it: no event until END.
assert.equal(decoder.push(Buffer.concat([pcs(0, [[810, 950]], true), pds(0, palette), odsFirst]), 1000), null, 'pgs: no picture before END');
const shown = decoder.push(Buffer.concat([odsLast, END]), 1000);
assert.ok(shown?.picture, 'pgs: a picture at END');
assert.equal(shown.ms, 1000, 'pgs: its time');
const [part] = shown.picture.parts;
assert.deepEqual([part.x, part.y, part.width, part.height], [810, 950, W, H], 'pgs: its place and size');
const px = decodePgs(part, shown.picture.palette);
let wrong = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[y * W + x] >>> 24 !== [0, 255, 128][pixel(x, y)]) wrong++;
assert.equal(wrong, 0, 'pgs: every pixel decoded');
const white = shown.picture.palette[1];
assert.ok((white & 0xff) >= 250 && ((white >> 8) & 0xff) >= 250 && ((white >> 16) & 0xff) >= 250, 'pgs: BT.709 white');
// A palette update shows the same object again in another colour, with no ODS (objects last the epoch).
const recoloured = decoder.push(Buffer.concat([pcs(1, [[810, 950]], false, 0, true), pds(0, [[1, 210, 146, 16, 255]]), END]), 2000);
assert.ok(recoloured?.picture && recoloured.picture.palette[1] !== white, 'pgs: palette update');
assert.equal(recoloured.picture.parts[0].rle, part.rle, 'pgs: the object kept from its epoch');
// No object: the screen clears.
assert.deepEqual(decoder.push(Buffer.concat([pcs(2, [], false), END]), 3000), { ms: 3000, picture: null }, 'pgs: clear');
// zlib-compressed blocks (mkvmerge's default for PGS).
const packed = new Uint8Array(zlib.deflateSync(Buffer.concat([pcs(3, [[810, 950]], true), pds(0, palette), odsFirst, odsLast, END])));
assert.ok(new PgsDecoder().push(await inflate(packed), 4000)?.picture, 'pgs: zlib block');

// --- Text subtitles from Matroska blocks ---
const { subtitleCue } = await load('src/media/subtitles.ts');
const frame = (text, ptsMs, durationMs) => ({ track: 3, ptsMs, durationMs, key: true, data: new TextEncoder().encode(text) });
const srt = subtitleCue({ codec: 'S_TEXT/UTF8' }, frame('<i>Bonjour</i> & <script>x</script>\nligne', 1000, 2000));
assert.deepEqual(srt, { startMs: 1000, endMs: 3000, html: '<i>Bonjour</i> &amp; x<br>ligne' }, 'srt: safe HTML');
const ass = subtitleCue({ codec: 'S_TEXT/ASS' }, frame('0,0,Default,,0,0,0,,{\\i1}Wicaby{\\i0}, oui\\Nfin', 5000));
assert.equal(ass.html, '<i>Wicaby</i>, oui<br>fin', 'ass: text field with commas, italics, line break');
assert.equal(ass.endMs - ass.startMs, 4000, 'ass: a cue without duration stays 4 s');
assert.equal(subtitleCue({ codec: 'S_TEXT/UTF8' }, frame('{\\an8}  ', 0, 10)), null, 'srt: an empty cue is dropped');

fs.rmSync(dir, { recursive: true, force: true });
console.log('mobile-web-check: ok');
