// Library analytics (Administration → Analytics, issue #17, src/shared/library-analytics.ts):
// 1. labels (codecs, DTS-HD, containers from the path or Emby's demuxer family, resolution classes), item rows,
//    the aggregation (shares, per-library split, size, mean bitrate), drill-down buckets and the CSV export;
// 2. the same scan as the app (scanQuery, small pages) on the Emby and Jellyfin mocks: every library pages
//    without gaps, the films cover the codecs, containers, resolutions and HDR formats, and both mocks agree.
// Usage: node tools/checks/library-analytics-check.mjs   (starts both mocks with MOCK_MUSIC=1 on 8991/8992)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-analytics-'));
const out = path.join(tmp, 'library-analytics.mjs');
await build({ entryPoints: [path.join(root, 'apps/desktop/src/shared/library-analytics.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const A = await import(pathToFileURL(out).href);

// ---- 1. Pure functions over fixtures ----
assert.equal(A.videoCodec('h264'), 'H.264');
assert.equal(A.videoCodec('HEVC'), 'HEVC');
assert.equal(A.videoCodec('mpeg2video'), 'MPEG-2');
assert.equal(A.videoCodec('prores'), 'PRORES', 'an unknown codec keeps its name');
assert.equal(A.videoCodec(undefined), '?');
assert.equal(A.audioCodec('dts'), 'DTS');
assert.equal(A.audioCodec('dts', 'DTS-HD MA'), 'DTS-HD');
assert.equal(A.audioCodec('dca', 'DTS:X'), 'DTS-HD');
assert.equal(A.audioCodec('pcm_s24le'), 'PCM');
assert.equal(A.audioCodec('eac3'), 'EAC3');
assert.equal(A.containerLabel('mov,mp4,m4a,3gp,3g2,mj2', '/m/a.mp4'), 'MP4', 'the extension wins over the demuxer family');
assert.equal(A.containerLabel('mov,mp4,m4a,3gp,3g2,mj2', '/m/a.mov'), 'MOV');
assert.equal(A.containerLabel('matroska,webm', '/m/a.webm'), 'WebM');
assert.equal(A.containerLabel('matroska,webm', 'http://host/stream'), 'MKV', 'no usable extension: the family');
assert.equal(A.containerLabel('mkv'), 'MKV');
assert.equal(A.containerLabel(undefined, undefined), undefined);
assert.equal(A.resolution(3840, 1608), '4k', 'letterboxed UHD');
assert.equal(A.resolution(1440, 1080), '1080p', 'cropped HD');
assert.equal(A.resolution(1280, 534), '720p');
assert.equal(A.resolution(720, 576), 'sd');
assert.equal(A.resolution(0, 0), undefined);

const v = (Codec, Width, Height, extra = {}) => ({ Index: 0, Type: 'Video', Codec, Width, Height, ...extra });
const au = (Codec, Language, extra = {}) => ({ Index: 1, Type: 'Audio', Codec, Language, ...extra });
const sub = (Language) => ({ Index: 2, Type: 'Subtitle', Codec: 'subrip', Language });
const item = (Id, Type, streams, src = {}, extra = {}) => ({ Id, Name: Id, Type, ...extra, ...(streams ? { MediaSources: [{ Id, Container: 'mkv', Path: `/m/${Id}.mkv`, Size: 1000, Bitrate: 8_000_000, ...src, MediaStreams: streams }] } : {}) });
const fixtures = [
  ['movies', item('m1', 'Movie', [v('hevc', 3840, 2160, { VideoRangeType: 'DOVIWithHDR10', DvProfile: 8, DvBlSignalCompatibilityId: 1 }), au('truehd', 'eng'), au('eac3', 'fre'), sub('fre')])],
  ['movies', item('m2', 'Movie', [v('h264', 1920, 1080, { VideoRange: 'SDR' }), au('ac3', 'fre')], { Container: 'mov,mp4,m4a', Path: '/m/m2.mp4', Size: 3000, Bitrate: 4_000_000 })],
  ['movies', item('m3', 'Movie', [v('hevc', 3840, 1600, { VideoRange: 'HDR', ExtendedVideoType: 'Hdr10Plus' }), au('eac3', 'eng'), au('eac3', 'eng'), sub('eng')], { Size: 6000, Bitrate: 0 })],
  ['shows', item('s1', 'Series', null, {}, { IsFolder: true })],
  ['shows', item('e1', 'Episode', [v('h264', 1280, 720), au('aac', undefined)], { Size: 500 }, { SeriesName: 'Show' })],
  ['music', item('al1', 'MusicAlbum', null)],
  ['music', item('t1', 'Audio', [au('flac', 'und')], { Container: 'flac', Path: '/music/t1.flac', Size: 40, Bitrate: 900_000 })],
  ['books', { Id: 'b1', Name: 'b1', Type: 'Book', Container: 'cbz', Path: '/b/b1.cbz' }],
];
const rows = fixtures.map(([lib, it]) => A.toRow(it, lib));
const r = (id) => rows.find((x) => x.id === id);
assert.deepEqual(r('m1'), { id: 'm1', name: 'm1', type: 'Movie', lib: 'movies', path: '/m/m1.mkv', container: 'MKV', size: 1000, bitrate: 8_000_000, video: 'HEVC', width: 3840, height: 2160, res: '4k', hdr: 'dv', audio: ['TrueHD', 'EAC3'], langs: 2, subs: 1 });
assert.equal(r('m2').container, 'MP4');
assert.equal(r('m2').hdr, undefined, 'SDR is no HDR bucket');
assert.deepEqual(r('m3').audio, ['EAC3'], 'one codec once per item');
assert.equal(r('m3').bitrate, undefined, 'no bitrate reported');
assert.equal(r('e1').name, 'Show · e1', 'an episode names its series');
assert.equal(r('e1').langs, 1, 'an untagged track is one language');
assert.deepEqual(r('s1'), { id: 's1', name: 's1', type: 'Series', lib: 'shows' }, 'a series is counted, nothing more');
assert.equal(r('t1').video, undefined);
assert.deepEqual(r('t1').audio, ['FLAC']);
assert.equal(r('t1').subs, undefined, 'subtitles and languages are for video only');
assert.equal(r('b1').container, 'CBZ');

const libs = [
  { id: 'movies', name: 'Films', type: 'movies' },
  { id: 'shows', name: 'Séries', type: 'tvshows' },
  { id: 'music', name: 'Musique', type: 'music' },
  { id: 'books', name: 'BD', type: 'books' },
];
const s = A.aggregate(rows, libs);
const map = (list) => Object.fromEntries(list.map((b) => [b.key, [b.count, Math.round(b.pct * 1000) / 1000]]));
assert.equal(s.total, 8);
assert.equal(s.libraries, 4);
assert.equal(s.size, 1000 + 3000 + 6000 + 500 + 40);
assert.deepEqual(map(s.types), { Movie: [3, 0.375], Series: [1, 0.125], Episode: [1, 0.125], MusicAlbum: [1, 0.125], Audio: [1, 0.125], other: [1, 0.125] });
assert.deepEqual(s.types.map((b) => b.key), ['Movie', 'Series', 'Episode', 'MusicAlbum', 'Audio', 'other'], 'types in a fixed order');
assert.deepEqual(map(s.video), { HEVC: [2, 0.5], 'H.264': [2, 0.5] }, 'shares of the video items');
assert.deepEqual(s.video.map((b) => b.key), ['H.264', 'HEVC'], 'ties by name');
assert.deepEqual(map(s.audio), { EAC3: [2, 0.4], TrueHD: [1, 0.2], AC3: [1, 0.2], AAC: [1, 0.2], FLAC: [1, 0.2] }, 'shares of the items with audio');
assert.deepEqual(map(s.containers), { MKV: [3, 0.5], MP4: [1, 0.167], FLAC: [1, 0.167], CBZ: [1, 0.167] }, 'every item with a file');
assert.deepEqual(map(s.resolutions), { '4k': [2, 0.5], '1080p': [1, 0.25], '720p': [1, 0.25], sd: [0, 0] }, 'resolution classes, empty ones kept');
assert.deepEqual(map(s.hdr), { hdr10: [0, 0], 'hdr10+': [1, 0.25], dv: [1, 0.25], hlg: [0, 0] }, 'HDR of the video items');
assert.deepEqual([s.noSubs.count, s.noSubs.pct], [2, 0.5], 'm2 and e1 have no subtitles');
assert.deepEqual([s.oneLang.count, s.oneLang.pct], [3, 0.75], 'm2, m3 and e1 have one audio language');
const lib = (id) => s.perLibrary.find((l) => l.id === id);
assert.deepEqual(lib('movies'), { id: 'movies', name: 'Films', type: 'movies', total: 3, counts: { Movie: 3, Series: 0, Episode: 0, MusicAlbum: 0, Audio: 0, other: 0 }, size: 10_000, bitrate: 6_000_000 }, 'mean bitrate over the items that report one');
assert.deepEqual([lib('shows').counts.Series, lib('shows').counts.Episode, lib('music').counts.MusicAlbum, lib('music').counts.Audio, lib('books').counts.other], [1, 1, 1, 1, 1]);
assert.equal(lib('books').bitrate, 0);
const empty = A.aggregate([], libs);
assert.equal(empty.total, 0);
assert.ok([...empty.types, ...empty.resolutions, empty.noSubs].every((b) => b.pct === 0), 'no division by zero');

// Drill-down lists exactly the rows a bucket counts.
for (const [facet, list] of [['type', s.types], ['video', s.video], ['audio', s.audio], ['container', s.containers], ['res', s.resolutions], ['hdr', s.hdr]])
  for (const b of list) assert.equal(rows.filter((x) => A.inBucket(x, facet, b.key)).length, b.count, `${facet}/${b.key}`);
assert.deepEqual(rows.filter((x) => A.inBucket(x, 'noSubs', 'yes')).map((x) => x.id), ['m2', 'e1']);

// CSV: BOM, header, quoting, formula guard.
const tricky = { ...r('m1'), name: '=HYPERLINK("x"), "Le, film"', path: 'C:\\a;b' };
const csv = A.toCsv([tricky, r('s1')], (id) => libs.find((l) => l.id === id).name);
assert.ok(csv.startsWith('\uFEFFlibrary,type,name,path,'), 'BOM then header');
const lines = csv.split('\r\n');
assert.equal(lines.length, 4, 'header, two rows, final CRLF');
assert.equal(lines[1], `Films,Movie,"'=HYPERLINK(""x""), ""Le, film""","C:\\a;b",MKV,HEVC,3840,2160,4k,dv,TrueHD EAC3,2,1,1000,8000000`);
assert.equal(lines[2], 'Séries,Series,s1,,,,,,,,,,,,');
assert.ok(A.toCsv([{ ...r('m1'), name: '\t=cmd' }], () => 'L').includes(`,'\t=cmd,`), 'a tab before a formula is guarded too');

// ---- 2. The mocks ----
const EMBY = 8991;
const JELLYFIN = 8992;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="analytics-check", Version="0"';

function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_MUSIC: '1', WICABY_TEST_SILENT: '1' } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function scanServer(name, base, login, tokenHeader, itemsPath, foldersPath) {
  const res = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
  assert.equal(res.status, 200, `${name}: sign-in`);
  const { AccessToken, User } = await res.json();
  const get = async (p, q) => {
    const url = `${base}${p}?${new URLSearchParams(Object.entries(q ?? {}).map(([k, x]) => [k, String(x)]))}`;
    const r2 = await fetch(url, { headers: tokenHeader(AccessToken) });
    assert.equal(r2.status, 200, `${name}: ${url}`);
    return r2.json();
  };
  const folders = await get(foldersPath);
  const list = (Array.isArray(folders) ? folders : folders.Items).map((f) => ({ id: f.ItemId, name: f.Name, type: f.CollectionType || 'mixed' }));
  const all = [];
  for (const l of list) {
    const PAGE = 25;
    const mine = [];
    for (let at = 0; ; at += PAGE) {
      const [p, extra] = itemsPath(User.Id);
      const page = await get(p, { ...A.scanQuery(l.id, at, PAGE), ...extra });
      mine.push(...page.Items.map((x) => A.toRow(x, l.id)));
      if (page.Items.length < PAGE || mine.length >= page.TotalRecordCount) {
        assert.equal(mine.length, page.TotalRecordCount, `${name}/${l.name}: every page`);
        break;
      }
    }
    assert.equal(new Set(mine.map((x) => x.id)).size, mine.length, `${name}/${l.name}: no item twice across pages`);
    all.push(...mine);
  }
  return { libs: list, rows: all, stats: A.aggregate(all, list) };
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));
  const emby = await scanServer(
    'emby', `http://127.0.0.1:${EMBY}/emby`, { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }),
    (uid) => [`/Users/${uid}/Items`, {}], '/Library/VirtualFolders/Query',
  );
  const jf = await scanServer(
    'jellyfin', `http://127.0.0.1:${JELLYFIN}`, { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }),
    (uid) => ['/Items', { userId: uid }], '/Library/VirtualFolders',
  );
  const st = emby.stats;
  const keys = (list) => list.filter((b) => b.count).map((b) => b.key);
  for (const c of ['H.264', 'HEVC', 'AV1', 'VP9', 'MPEG-2', 'MPEG-4']) assert.ok(keys(st.video).includes(c), `emby: a ${c} film`);
  for (const c of ['AAC', 'EAC3', 'AC3', 'TrueHD', 'DTS-HD', 'FLAC', 'Opus', 'MP3']) assert.ok(keys(st.audio).includes(c), `emby: ${c} audio`);
  for (const c of ['MKV', 'MP4', 'AVI', 'MOV', 'WebM', 'TS']) assert.ok(keys(st.containers).includes(c), `emby: a ${c} file`);
  assert.deepEqual(keys(st.resolutions), ['4k', '1080p', '720p', 'sd'], 'emby: every resolution class');
  assert.deepEqual(keys(st.hdr).sort(), ['dv', 'hdr10', 'hdr10+', 'hlg'], 'emby: every HDR format');
  assert.ok(st.noSubs.count > 0 && st.oneLang.count > 0, 'emby: films without subtitles and with one audio language');
  const per = (id) => st.perLibrary.find((l) => l.id === id);
  assert.ok(per('lib-movies').counts.Movie >= 60 && per('lib-movies').size > 0 && per('lib-movies').bitrate > 0, 'emby: the films library');
  assert.ok(per('lib-shows').counts.Series === 1 && per('lib-shows').counts.Episode === 16, 'emby: one series, 16 episodes (virtual ones left out)');
  assert.ok(per('lib-music').counts.MusicAlbum > 0 && per('lib-music').counts.Audio > 0, 'emby: albums and songs in the music library');
  // Drill-down rows carry what the sheet shows.
  const dts = emby.rows.find((x) => A.inBucket(x, 'audio', 'DTS-HD'));
  assert.ok(dts.path && dts.video && dts.res && dts.container, 'emby: a drill-down row has its path and streams');

  assert.deepEqual(jf.libs.map((l) => l.id), emby.libs.map((l) => l.id), 'jellyfin: the same libraries');
  assert.deepEqual(jf.stats, st, 'jellyfin: the same analytics');
  console.log(`library-analytics-check: labels, rows, aggregation, drill-down and CSV OK; ${st.total} items scanned alike on the Emby and Jellyfin mocks`);
} finally {
  for (const c of children) c.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
