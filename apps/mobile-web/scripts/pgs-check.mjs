// PGS check: a .sup with known pictures (made here, run-length coded as Blu-ray authoring tools do) is muxed into
// .dev/media/h264-aac.mkv by ffmpeg, plainly and zlib-compressed by hand as mkvmerge stores PGS; the app's demuxer
// and PGS decoder (src/media) must give back each picture, pixel for pixel, at its time, and the clears.
// Run: FFMPEG_DIR=<ffmpeg bin> node apps/mobile-web/scripts/pgs-check.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FF = process.env.FFMPEG_DIR ?? '';
const bin = (name) => (FF ? path.join(FF, name) : name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgs-check-'));
const src = path.join(ROOT, 'apps', 'mobile-web', 'src', 'media').split(path.sep).join('/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export { readHeader, clusters } from '${src}/matroska';\nexport { BufferSource } from '${src}/source';\nexport { PgsDecoder, decodePgs, inflate } from '${src}/pgs';`);
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const M = await import(pathToFileURL(out).href);

// ---- A .sup: two pictures, each cleared ----
const W = 300;
const H = 40;
// Colour 1 border, colour 2 inside, 0 (transparent) in a vertical stripe: runs of every length class.
const pixel = (pic, x, y) => (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? 1 : x >= 100 + pic * 20 && x < 180 + pic * 20 ? 0 : 2);

function rle(pic) {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; ) {
      const c = pixel(pic, x, y);
      let n = 1;
      while (x + n < W && pixel(pic, x + n, y) === c && n < 16383) n++;
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
function supPacket(ms, segment) {
  const pts = Math.round(ms * 90);
  const h = Buffer.alloc(10);
  h.write('PG', 0, 'ascii');
  h.writeUInt32BE(pts, 2);
  h.writeUInt32BE(0, 6);
  return Buffer.concat([h, segment]);
}
// YCbCr: colour 1 white, colour 2 dark grey half transparent.
const PAL = [
  [1, 235, 128, 128, 255],
  [2, 60, 128, 128, 128],
];
function displaySet(ms, n, pic) {
  const pcs = Buffer.from([...u16(1920), ...u16(1080), 0x10, ...u16(n), pic === null ? 0x00 : 0x80, 0, 0, pic === null ? 0 : 1, ...(pic === null ? [] : [...u16(0), 0, 0, ...u16(810 + pic * 10), ...u16(950)])]);
  const parts = [seg(0x16, pcs)];
  if (pic !== null) {
    parts.push(seg(0x17, Buffer.from([1, 0, ...u16(810), ...u16(950), ...u16(W + 40), ...u16(H)])));
    parts.push(seg(0x14, Buffer.from([0, 0, ...PAL.flat()])));
    const data = rle(pic);
    const len = data.length + 4;
    parts.push(seg(0x15, Buffer.concat([Buffer.from([...u16(0), 0, 0xc0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...u16(W), ...u16(H)]), data])));
  }
  parts.push(seg(0x80, Buffer.alloc(0)));
  return Buffer.concat(parts.map((p) => supPacket(ms, p)));
}
const SETS = [
  { ms: 1000, pic: 0 },
  { ms: 3000, pic: null },
  { ms: 5000, pic: 1 },
  { ms: 7000, pic: null },
];
const sup = path.join(tmp, 'subs.sup');
fs.writeFileSync(sup, Buffer.concat(SETS.map((s, i) => displaySet(s.ms, i, s.pic))));
const mkv = path.join(tmp, 'pgs.mkv');
const r = spawnSync(bin('ffmpeg'), ['-v', 'error', '-y', '-copyts', '-i', path.join(ROOT, '.dev', 'media', 'h264-aac.mkv'), '-i', sup, '-map', '0:v', '-map', '1', '-c', 'copy', '-t', '9', mkv], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);

// ---- Decode with the app's code ----
async function check(label, zip) {
  const source = new M.BufferSource(new Uint8Array(fs.readFileSync(mkv)));
  const header = await M.readHeader(source);
  const track = header.tracks.find((t) => t.codec === 'S_HDMV/PGS');
  if (!track) throw new Error(`${label}: no PGS track`);
  const decoder = new M.PgsDecoder();
  const events = [];
  for await (const frames of M.clusters(source, header, header.firstCluster))
    for (const f of frames) {
      if (f.track !== track.number) continue;
      const data = zip ? await M.inflate(new Uint8Array(zlib.deflateSync(f.data))) : f.data;
      const e = decoder.push(data, f.ptsMs);
      if (e) events.push(e);
    }
  const errors = [];
  if (events.length !== SETS.length) errors.push(`${events.length} display sets, ${SETS.length} expected`);
  SETS.forEach((s, i) => {
    const e = events[i];
    if (!e) return;
    if (Math.abs(e.ms - s.ms) > 1) errors.push(`set ${i} at ${e.ms} ms, ${s.ms} expected`);
    if ((e.picture === null) !== (s.pic === null)) errors.push(`set ${i}: ${e.picture ? 'a picture' : 'a clear'}`);
    if (!e.picture) return;
    const [part] = e.picture.parts;
    if (part.width !== W || part.height !== H || part.x !== 810 + s.pic * 10 || part.y !== 950) errors.push(`set ${i}: part ${part.width}x${part.height} at ${part.x},${part.y}`);
    const px = M.decodePgs(part, e.picture.palette);
    let bad = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((px[y * W + x] >>> 24) !== [0, 255, 128][pixel(s.pic, x, y)]) bad++;
    if (bad) errors.push(`set ${i}: ${bad} pixels wrong`);
    const white = e.picture.palette[1];
    if ((white & 0xff) < 250 || ((white >> 8) & 0xff) < 250) errors.push(`set ${i}: colour 1 is ${white.toString(16)}, white expected`);
  });
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${label}${errors.length ? ': ' + errors.join('; ') : `: ${events.length} display sets`}`);
  return errors.length;
}

const failed = (await check('pgs.mkv', false)) + (await check('pgs.mkv zlib', true));

// For the player check (PLAYER_PGS=1): the test film with a French SRT and an English PGS track, as the mock server
// lists them, the PGS showing a picture every other two seconds all along.
const film = path.join(ROOT, '.dev', 'media', 'h264-aac.mkv');
const filmMs = Number(spawnSync(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film], { encoding: 'utf8' }).stdout) * 1000 || 30_000;
const dense = [];
for (let ms = 1000; ms + 1000 < filmMs; ms += 2000) dense.push({ ms, pic: (ms / 2000) % 2 | 0 }, { ms: ms + 1000, pic: null });
const denseSup = path.join(tmp, 'dense.sup');
fs.writeFileSync(denseSup, Buffer.concat(dense.map((s, i) => displaySet(s.ms, i, s.pic))));
const keep = path.join(ROOT, '.dev', 'media', 'pgs', 'h264-pgs.mkv');
fs.mkdirSync(path.dirname(keep), { recursive: true });
const k = spawnSync(bin('ffmpeg'), ['-v', 'error', '-y', '-copyts', '-i', film, '-i', path.join(ROOT, '.dev', 'media', 'subs.srt'), '-i', denseSup, '-map', '0:v', '-map', '0:a', '-map', '1', '-map', '2', '-c', 'copy', keep], { encoding: 'utf8' });
if (k.status !== 0) console.log(`(no player test file: ${k.stderr.trim().split('\n')[0]})`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? 'pgs-check: failed' : 'pgs-check: ok');
process.exit(failed ? 1 : 0);
