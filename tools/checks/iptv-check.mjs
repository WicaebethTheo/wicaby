// Client-side IPTV (apps/desktop/src/shared/iptv, main/iptv/load.ts): the M3U and XMLTV parsers against the shared
// vectors in fixtures/iptv (Android's IptvParityTest replays the same files), the streaming guide in odd chunk sizes
// and gzipped, the loader's trust boundary (schemes, size caps, HTTP errors), memory on a big guide, the log
// redaction of Xtream addresses, and the mock provider of tools/mock-server/mock-iptv.mjs end to end (loopback only).
// Usage: node tools/checks/iptv-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';
import { startMockIptv } from '../mock-server/mock-iptv.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const fx = path.join(import.meta.dirname, 'fixtures', 'iptv');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-iptv-'));
const out = path.join(tmp, 'iptv.mjs');

for (const m of ['m3u', 'xmltv', 'guide']) {
  const text = fs.readFileSync(path.join(repo, 'apps/desktop/src/shared/iptv', `${m}.ts`), 'utf8');
  assert.ok(!/from ['"](node:|electron|fs|path)/.test(text), `${m}.ts imports Node or Electron`);
}
await build({
  stdin: {
    contents: [
      "export * as m3u from './shared/iptv/m3u';",
      "export * as xmltv from './shared/iptv/xmltv';",
      "export * as guide from './shared/iptv/guide';",
      "export * as load from './main/iptv/load';",
      "export { redact } from './main/core/log';",
    ].join('\n'),
    resolveDir: path.join(repo, 'apps/desktop/src'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});
const { m3u, xmltv, guide, load, redact } = await import(pathToFileURL(out).href);
let cases = 0;
const eq = (a, b, msg) => {
  assert.deepEqual(JSON.parse(JSON.stringify(a ?? null)), b, msg);
  cases++;
};
const read = (f, enc = 'utf8') => fs.readFileSync(path.join(fx, f), enc);

// ---- M3U vectors (BOM + CRLF, missing attributes, quotes, EXTVLCOPT, EXTGRP, duplicates, skipped lines) ----
const m3uExpected = JSON.parse(read('m3u.expected.json'));
for (const [file, want] of Object.entries(m3uExpected)) eq(m3u.parseM3u(read(file)), want, file);
{
  const raw = read('edge.m3u', null);
  assert.equal(raw[0], 0xef, 'edge.m3u keeps its BOM');
  assert.ok(raw.includes(Buffer.from('\r\n')), 'edge.m3u keeps its CRLF');
  const pl = m3u.parseM3u(raw.toString('utf8'));
  eq(pl.guides, ['http://guide.example/a.xml.gz', 'http://guide.example/b.xml'], 'url-tvg and x-tvg-url, deduplicated');
  eq(pl.channels.filter((c) => c.tvgId === 'news.fr').length, 2, 'duplicate tvg-id kept as two channels');
  eq(new Set(pl.channels.map((c) => c.id)).size, pl.channels.length, 'ids unique');
  assert.ok(pl.channels.every((c) => /^[A-Za-z0-9-]{1,64}$/.test(c.id)), 'ids are path-safe item ids');
  assert.ok(pl.channels.every((c) => /^https?:\/\//.test(c.url)), 'only http(s) streams');
  // Ids do not depend on the URL (Xtream credentials rotate).
  eq(m3u.parseM3u('#EXTINF:-1 tvg-id="a",A\nhttp://x/u/p1/1.ts').channels[0].id, m3u.parseM3u('#EXTINF:-1 tvg-id="a",A\nhttp://x/u/p2/1.ts').channels[0].id, 'id stable across URL changes');
  eq(m3u.parseM3u('#EXTM3U\n#EXTINF:-1,Bad\njavascript:alert(1)\n#EXTINF:-1,File\nfile:///etc/passwd').channels.length, 0, 'javascript: and file: streams dropped');
  eq(m3u.parseM3u('#EXTM3U\n#EXTINF:-1 tvg-logo="javascript:alert(1)",X\nhttp://a/1.ts').channels[0].logo, null, 'non-image logo dropped');
  eq(m3u.parseM3u('').channels.length, 0, 'empty text');
  eq(m3u.parseM3u('#EXTINF:-1,A\n#EXTVLCOPT:http-user-agent=Lecteur é\nhttp://a/1.ts').channels[0].userAgent ?? null, null, 'non-ASCII header value dropped (Android twin)');
  eq(m3u.parseM3u(`#EXTINF:-1,${'x'.repeat(70_000)}\nhttp://a/1.ts`).skipped, 1, 'over-long line skipped');
}

// ---- XMLTV dates ----
eq(xmltv.parseXmltvDate('20261014120000 +0200'), Date.UTC(2026, 9, 14, 10), '+0200');
eq(xmltv.parseXmltvDate('20261014120000 -0530'), Date.UTC(2026, 9, 14, 17, 30), '-0530');
eq(xmltv.parseXmltvDate('20261014120000 +02:00'), Date.UTC(2026, 9, 14, 10), '+02:00');
eq(xmltv.parseXmltvDate('20261014120000'), Date.UTC(2026, 9, 14, 12), 'no zone is UTC');
eq(xmltv.parseXmltvDate('202610141200'), Date.UTC(2026, 9, 14, 12), 'no seconds');
eq(xmltv.parseXmltvDate('20261014120000 Z'), Date.UTC(2026, 9, 14, 12), 'Z');
for (const bad of ['', '2026-10-14', '20261314120000', 'x']) assert.ok(Number.isNaN(xmltv.parseXmltvDate(bad)), `bad date ${bad}`);
eq(xmltv.decodeXml('a &amp; b &lt;c&gt; &#233; &#x2014; <![CDATA[<i>&</i>]]> &bogus;'), 'a & b <c> é — <i>&</i> &bogus;', 'entities and CDATA');

// ---- Guide vectors: whole, in small chunks, in random chunks, gzipped through the loader ----
const gWant = JSON.parse(read('guide.expected.json'));
const playlist = m3u.parseM3u(read(gWant.playlist));
const from = Date.parse(gWant.from);
const to = Date.parse(gWant.to);
const shape = (res, c) => ({
  playlist: gWant.playlist,
  from: gWant.from,
  to: gWant.to,
  channels: c.parser.channels,
  seen: c.parser.programmes,
  kept: c.parser.kept,
  skipped: c.parser.skipped,
  programmes: Object.fromEntries([...res].map(([id, l]) => [id, l.map((p) => ({ ...p, start: new Date(p.start).toISOString(), stop: new Date(p.stop).toISOString() }))])),
});
const xml = read('guide.xml');
const run = (chunks) => {
  const c = guide.collectGuide(playlist.channels, from, to);
  for (const ch of chunks) c.parser.push(ch);
  return shape(c.finish(), c);
};
eq(run([xml]), gWant, 'guide whole');
const split = (s, n) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));
eq(run(split(xml, 7)), gWant, 'guide in 7-char chunks');
eq(run(split(xml, 1)), gWant, 'guide one char at a time');
{
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 97) + 1;
  const parts = [];
  for (let i = 0; i < xml.length; ) {
    const n = rnd();
    parts.push(xml.slice(i, i + n));
    i += n;
  }
  eq(run(parts), gWant, 'guide in random chunks');
}
// Guide windows are relative to "now": the loader keeps now - 6 h … now + 7 days.
const now = Date.parse('2026-10-14T12:00:00Z');
assert.equal(now - load.GUIDE_PAST_MS, from);
assert.equal(now + load.GUIDE_AHEAD_MS, Date.parse('2026-10-21T12:00:00Z'));
const fake = (body, init = {}) => async () => new Response(body, { status: 200, ...init });
{
  const gz = zlib.gzipSync(Buffer.from(xml));
  const r = await load.loadGuide('http://guide.example/a.xml.gz', playlist, fake(gz), now);
  eq(Object.fromEntries([...r.programmes].map(([id, l]) => [id, l.length])), Object.fromEntries(Object.entries(gWant.programmes).map(([id, l]) => [id, l.length])), 'gzip guide through the loader');
  eq(r.count, 10, 'programme count (a shared one counts per channel)');
  // gzip detected by its bytes, not by the name or a header.
  const r2 = await load.loadGuide('http://guide.example/guide.xml', playlist, fake(gz), now);
  eq(r2.count, 10, 'gzip without .gz name');
  const r3 = await load.loadGuide('http://guide.example/guide.xml.gz', playlist, fake(Buffer.from(xml)), now);
  eq(r3.count, 10, 'plain XML under a .gz name');
}

// ---- Loader trust boundary ----
const rejects = async (p, code, msg) => {
  await assert.rejects(p, (e) => e.code === code, msg);
  cases++;
};
const never = async () => assert.fail('must not fetch');
await rejects(load.loadPlaylist('file:///etc/passwd', never), 'invalid', 'file: URL refused');
await rejects(load.loadPlaylist('ftp://a.example/x.m3u', never), 'invalid', 'ftp refused');
await rejects(load.loadPlaylist('javascript:alert(1)', never), 'invalid', 'javascript refused');
await rejects(load.loadPlaylist('http://a.example/x.m3u', fake('nope', { status: 404 })), 'http', '404');
await rejects(load.loadPlaylist('http://a.example/x.m3u', fake('#EXTM3U\n', { headers: { 'content-length': String(load.PLAYLIST_MAX_BYTES + 1) } })), 'tooBig', 'declared too big');
{
  // An endless body without a length: cut at the cap.
  const endless = new ReadableStream({
    pull(ctl) {
      ctl.enqueue(new Uint8Array(1024 * 1024).fill(0x23));
    },
  });
  await rejects(load.loadPlaylist('http://a.example/x.m3u', fake(endless)), 'tooBig', 'streamed past the cap');
}
await rejects(load.loadPlaylist('http://a.example/x.m3u', fake('#EXTM3U\n#EXTINF:-1,X\nrtmp://a/b\n#EXTINF:-1,Y\nudp://@239.0.0.1:1234\n')), 'unsupported', 'only rtmp/udp streams');
await rejects(load.loadPlaylist('http://a.example/x.m3u', fake('#EXTM3U\n#EXTINF:-1,X\n')), 'empty', 'no stream at all');
{
  const at = performance.now();
  await rejects(load.loadPlaylist('http://a.example/x.m3u', fake('\n'.repeat(200_000))), 'empty', 'blank lines');
  assert.ok(performance.now() - at < 1000, 'blank lines: linear scheme scan');
}
{
  // Freebox-shaped (desktop only, so inline and not in the shared fixtures Android replays): rtsp kept for mpv.
  const fbx = [
    '#EXTM3U',
    '#FBX-X-SERVER-VERSION:2',
    '#EXTINF:0,2 - France 2 (standard)',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=201&flavour=sd',
    '#EXTINF:0,2 - France 2 (HD)',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=201&flavour=hd',
    '#EXTINF:0,2 - France 2 (auto)',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=201',
    '#EXTINF:0,1 - TF1 (bas débit)',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=612&flavour=ld',
    '#EXTINF:0,1 - TF1 (auto)',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=612',
    '#EXTINF:0 tvg-id="France3.fr" tvg-logo="http://logo.example/f3.png" group-title="TNT",3 - France 3',
    'rtsp://box.example/fbxtv_pub/stream?namespace=1&service=203',
    '#EXTINF:0,Secure',
    'rtsps://box.example/s',
  ].join('\n');
  const pl = await load.loadPlaylist('http://box.example/freeboxtv/playlist.m3u', fake(fbx));
  const u = (sv) => `rtsp://box.example/fbxtv_pub/stream?namespace=1&service=${sv}`;
  eq(pl.channels.map((c) => c.url), [`${u(201)}&flavour=hd`, u(612), u(203), 'rtsps://box.example/s'], 'freebox: one channel per service, HD else auto');
  eq(pl.channels.map((c) => c.name), ['France 2', 'TF1', 'France 3', 'Secure'], 'freebox: box number and quality out of the name');
  eq(new Set(pl.channels.map((c) => c.id)).size, 4, 'freebox: ids unique');
  eq([pl.channels[2].tvgId, pl.channels[2].logo, pl.channels[2].group], ['France3.fr', 'http://logo.example/f3.png', 'TNT'], 'freebox: tvg-id, logo, group');
  eq(pl.channels.map((c) => c.number), ['2', '1', '3', ''], 'freebox: the box numbering');
  eq(
    m3u.parseM3u(['lavf://rtsp://x', 'edl://x', 'file:///x', 'rtsp://a b', 'rtp://@239.0.0.1:5004', 'rtspx://x', 'av://dshow:x'].map((u) => `#EXTINF:-1,X\n${u}`).join('\n')).channels.length,
    0,
    'mpv protocols, multicast and spaced URLs dropped',
  );
}
await rejects(load.loadPlaylist(path.join(tmp, 'missing.m3u'), never), 'unreachable', 'missing local file');
{
  const f = path.join(tmp, 'local.m3u');
  fs.writeFileSync(f, read('plain.m3u'));
  eq((await load.loadPlaylist(f, never)).channels.length, 2, 'local file');
}
eq(load.hostOf('http://user:pass@iptv.example:8080/get.php?username=u&password=p'), 'iptv.example:8080', 'host only');

// ---- Memory: a 100k-programme guide for 2,000 channels, 10 of them in the playlist ----
{
  const pl = m3u.parseM3u(Array.from({ length: 10 }, (_, i) => `#EXTINF:-1 tvg-id="ch${i * 200}",C${i}\nhttp://a/${i}.ts`).join('\n'));
  const base = Date.UTC(2026, 9, 14);
  const t = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const c = guide.collectGuide(pl.channels, base - 6 * 3600e3, base + 7 * 24 * 3600e3);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  let bytes = 0;
  for (let ch = 0; ch < 2000; ch++) {
    let s = '';
    for (let k = 0; k < 50; k++) {
      const st = base + k * 3600e3;
      s += `<programme start="${t(st)}" stop="${t(st + 3600e3)}" channel="ch${ch}"><title>Programme ${k}</title><desc>${'Lorem ipsum '.repeat(20)}</desc></programme>\n`;
    }
    bytes += s.length;
    c.parser.push(s);
  }
  const res = c.finish();
  const ms = performance.now() - started;
  const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  eq(c.count(), 500, 'only the playlist channels kept');
  eq(res.size, 10, 'ten channels');
  assert.ok(grew < 64, `heap grew ${grew.toFixed(1)} MB on a ${(bytes / 1e6).toFixed(0)} MB guide`);
  console.log(`iptv-check: synthetic guide ${(bytes / 1e6).toFixed(0)} MB, 100000 programmes → 500 kept in ${ms.toFixed(0)} ms, heap +${grew.toFixed(1)} MB`);
}

// ---- Log redaction of Xtream addresses ----
eq(redact('Failed to open http://p.example/get.php?username=wika&password=s3cret&type=m3u_plus'), 'Failed to open http://p.example/get.php?username=***&password=***&type=m3u_plus', 'query account');
eq(redact('Cannot open http://p.example/live/wika/s3cret/42.ts'), 'Cannot open http://p.example/live/***/***/42.ts', 'path account');

// ---- The mock provider, end to end (127.0.0.1) ----
{
  const mock = await startMockIptv();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const f = (url, init) => fetch(url, init);
    const pl = await load.loadPlaylist(`${base}/iptv/playlist.m3u`, f);
    eq(pl.channels.length, 10, 'mock: 10 channels');
    eq([...new Set(pl.channels.map((c) => c.group))], ['Infos', 'Sport', 'Jeunesse'], 'mock: 3 groups');
    eq(pl.guides, [`${base}/iptv/guide.xml.gz`], 'mock: url-tvg');
    eq(pl.channels[5].userAgent, 'WicabyMock/1.0', 'mock: EXTVLCOPT user agent');
    assert.ok(pl.channels[8].logo.startsWith('data:image/png;base64,'), 'mock: data logo');
    eq(pl.channels[9].logo, null, 'mock: no logo');
    const g = await load.loadGuide(pl.guides[0], pl, f);
    eq(g.programmes.size, 9, 'mock: every channel with a tvg-id has a guide');
    eq(g.programmes.get(pl.channels[3].id).length, g.programmes.get(pl.channels[4].id).length, 'mock: shared tvg-id');
    const nowP = [...g.programmes.values()].every((l) => l.some((p) => p.start <= Date.now() && p.stop > Date.now()));
    assert.ok(nowP, 'mock: something airs now on every channel');
    const x = await load.loadPlaylist(`${base}/get.php?username=wika&password=s3cret&type=m3u_plus`, f);
    eq(x.channels.length, 10, 'mock: Xtream address');
    const fb = await load.loadPlaylist(`${base}/freeboxtv/playlist.m3u`, f);
    eq(fb.channels.length, 2, 'mock: Freebox playlist, 2 channels × 3 flavours merged');
    assert.ok(fb.channels.every((c) => c.url.endsWith('&flavour=hd')), 'mock: Freebox HD kept');
    assert.ok(fb.channels.every((c) => c.url.startsWith(`rtsp://127.0.0.1:${mock.port}/fbxtv_pub/stream?namespace=1&service=`)), 'mock: Freebox rtsp URLs');
    await rejects(load.loadPlaylist(`${base}/get.php?username=wika&password=bad&type=m3u_plus`, f), 'http', 'mock: bad Xtream credentials');
  } finally {
    await mock.close();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`iptv-check: ok (${cases} cases)`);
