// Remux check: each MKV of .dev/media (generated with ffmpeg, see docs) goes through the app's own demuxer and
// fMP4 muxer (src/media), and ffmpeg must decode the result with no error, with as many frames and as long a
// duration as the source. Run: node apps/mobile-web/scripts/remux-check.mjs [file.mkv…]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MEDIA = path.join(ROOT, '.dev', 'media');
const OUT = path.join(ROOT, '.dev', 'remux');
const FF = process.env.FFMPEG_DIR ?? '';
const bin = (name) => (FF ? path.join(FF, name) : name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-check-'));
const entry = path.join(tmp, 'entry.ts');
const src = path.join(ROOT, 'apps', 'mobile-web', 'src', 'media').split(path.sep).join('/');
fs.writeFileSync(
  entry,
  `export { readHeader, clusters, cueBefore } from '${src}/matroska';
   export { Remuxer, LEAD_MS } from '${src}/remux';
   export { BufferSource } from '${src}/source';
   export { subtitleCue } from '${src}/subtitles';`,
);
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const M = await import(pathToFileURL(out).href);

function probe(file, stream) {
  const r = spawnSync(bin('ffprobe'), ['-v', 'error', '-select_streams', stream, '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return { codec: j.streams[0]?.codec_name, frames: Number(j.streams[0]?.nb_read_frames), duration: Number(j.format?.duration) };
}

function decodeErrors(file) {
  const r = spawnSync(bin('ffmpeg'), ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return (r.stderr || '').trim();
}

let failed = 0;
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(MEDIA).filter((f) => f.endsWith('.mkv'));
fs.mkdirSync(OUT, { recursive: true });
for (const name of files) {
  const file = path.isAbsolute(name) ? name : path.join(MEDIA, name);
  const base = path.basename(file, '.mkv');
  const source = new M.BufferSource(new Uint8Array(fs.readFileSync(file)));
  const header = await M.readHeader(source);
  const video = header.tracks.find((t) => t.kind === 'video');
  const audio = header.tracks.find((t) => t.kind === 'audio');
  const rx = new M.Remuxer(video, audio);
  const parts = { video: [], audio: [] };
  const texts = header.tracks.filter((t) => t.kind === 'subtitle');
  const cues = [];
  for await (const frames of M.clusters(source, header, header.firstCluster)) {
    for (const o of rx.push(frames)) parts[o.kind].push(o.data);
    for (const f of frames) {
      const t = texts.find((x) => x.number === f.track);
      const c = t && M.subtitleCue(t, f);
      if (c) cues.push(c);
    }
  }
  for (const o of rx.flush()) parts[o.kind].push(o.data);
  const report = [`${base}: cues ${header.cues.length}, duration ${Math.round(header.durationMs ?? 0)} ms`];
  for (const kind of ['video', 'audio']) {
    const r = kind === 'video' ? rx.video : rx.audio;
    if (!r) continue;
    const mp4 = path.join(OUT, `${base}.${kind}.mp4`);
    fs.writeFileSync(mp4, Buffer.concat([Buffer.from(r.init), ...parts[kind].map((p) => Buffer.from(p))]));
    const want = probe(file, kind === 'video' ? 'v:0' : 'a:0');
    const got = probe(mp4, kind === 'video' ? 'v:0' : 'a:0');
    const errors = decodeErrors(mp4);
    const ok = got.codec === want.codec && Math.abs(got.frames - want.frames) <= 1 && !errors;
    if (!ok) failed++;
    report.push(`  ${ok ? 'ok  ' : 'FAIL'} ${kind} ${r.mime} · frames ${got.frames}/${want.frames} · ${got.duration?.toFixed(2)} s${errors ? `\n    ${errors.split('\n').slice(0, 3).join('\n    ')}` : ''}`);
  }
  // The test files carry two cues (1-4 s "Bonjour <i>Wicaby</i>", 6-9 s): both read back, timed and styled.
  if (texts.length) {
    const ok = cues.length === 2 && cues[0].startMs === 1000 && cues[0].endMs === 4000 && cues[0].html.includes('<i>Wicaby</i>');
    if (!ok) failed++;
    report.push(`  ${ok ? 'ok  ' : 'FAIL'} subtitles ${texts.map((t) => t.codec).join(',')} · ${cues.map((c) => `${c.startMs}-${c.endMs} ${c.html}`).join(' | ')}`);
  }
  console.log(report.join('\n'));
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`remux-check: ${failed} track(s) failed`);
  process.exit(1);
}
console.log('remux-check: ok');
