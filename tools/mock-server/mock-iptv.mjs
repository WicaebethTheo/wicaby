// A fake IPTV provider for the client-side IPTV sources (desktop and Android): an M3U playlist of 10 channels in 3
// groups, an XMLTV guide (gzip) around now, channel logos and live streams. Everything is invented and served from
// 127.0.0.1 only; nothing here contacts the internet.
//
//   node tools/mock-server/mock-iptv.mjs [port]         (default 8098; the Android emulator reaches it at 10.0.2.2)
//   import { startMockIptv } from './mock-iptv.mjs'      (checks: a free port)
//
// Routes (URLs inside the playlist and the guide follow the request's Host header):
//   /iptv/playlist.m3u                  the playlist, url-tvg pointing at /iptv/guide.xml.gz
//   /get.php?username=wika&password=s3cret&type=m3u_plus   the same, Xtream style (401 with other credentials)
//   /iptv/guide.xml.gz, /iptv/guide.xml the guide: now - 6 h to now + 3 days, half the channels in +0200
//   /iptv/logo/<n>.png                  a flat 64×64 PNG per channel (channel 9 has a data: logo, channel 10 none)
//   /iptv/live/<n>/index.m3u8           a live HLS window of 4 six-second segments (/iptv/live/<n>/seg-<seq>.ts)
//   /iptv/stream/<n>.ts                 a raw MPEG-TS that loops the clip for 2 minutes
//   /freeboxtv/playlist.m3u             a Freebox-shaped playlist: rtsp:// entries (fbxtv_pub, flavours), no tvg-id;
//                                       the rtsp URLs name this host but nothing answers them (parser checks only)
//   /Mock/State                         hits per route and the user agents seen
// Channel 6 needs the User-Agent its #EXTVLCOPT names (403 otherwise, tagged UA-MISSING).
//
// Streams are a generated test pattern with NO audio track, encoded once by mpv (MOCK_MPV, else vendor/mpv, else mpv
// on PATH) into the OS temp folder. Without mpv the stream routes answer 503 (tagged NO-MPV); the rest still works.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HOUR = 3_600_000;
const SEG_S = 6;
const UA = 'WicabyMock/1.0';
const here = path.dirname(fileURLToPath(import.meta.url));

// [name, group, tvg-id, stream kind, pattern, colour]
export const CHANNELS = [
  ['Mock Info', 'Infos', 'info.mock', 'hls', 'testsrc2', [40, 90, 160]],
  ['Mock Info 24', 'Infos', 'info24.mock', 'ts', 'smptebars', [60, 60, 60]],
  ['Mock Météo', 'Infos', 'meteo.mock', 'hls', 'smptehdbars', [20, 140, 200]],
  ['Mock Sport', 'Sport', 'sport.mock', 'hls', 'testsrc2', [30, 150, 70]],
  ['Mock Sport 2', 'Sport', 'sport.mock', 'ts', 'smptebars', [30, 120, 60]],
  ['Mock Arena', 'Sport', 'arena.mock', 'hls', 'smptehdbars', [180, 110, 20]],
  ['Mock Kids', 'Jeunesse', 'kids.mock', 'hls', 'testsrc2', [200, 70, 120]],
  ['Mock Dessins animés', 'Jeunesse', 'cartoons.mock', 'ts', 'smptehdbars', [150, 60, 190]],
  ['Mock Docs', 'Jeunesse', 'docs.mock', 'hls', 'smptebars', [110, 110, 30]],
  ['Mock Sans guide', 'Jeunesse', '', 'hls', 'testsrc2', [90, 90, 90]],
];

const TITLES = {
  Infos: ['Le journal', 'Édition spéciale', 'Le débat', 'Météo & trafic', 'Le magazine'],
  Sport: ['Multiplex', 'Le direct', 'Résumé', 'Avant-match', 'Le grand plateau'],
  Jeunesse: ['Les aventures', 'Le petit atelier', 'Dessins animés', 'Le documentaire', 'Le jeu'],
};

// ---- Fixtures ----

function crc(buf) {
  return zlib.crc32 ? zlib.crc32(buf) : crcFallback(buf);
}
function crcFallback(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

// A flat 64×64 RGB PNG with a lighter band, no text (the logo of channel n).
export function logoPng([r, g, b]) {
  const w = 64;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) {
    const band = y > 20 && y < 44 ? 60 : 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, r + band);
      raw[o + 1] = Math.min(255, g + band);
      raw[o + 2] = Math.min(255, b + band);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function playlist(base) {
  const lines = [`#EXTM3U url-tvg="${base}/iptv/guide.xml.gz"`];
  CHANNELS.forEach(([name, group, tvg, kind, , colour], i) => {
    const n = i + 1;
    const logo = n === 9 ? `data:image/png;base64,${logoPng(colour).toString('base64')}` : n === 10 ? '' : `${base}/iptv/logo/${n}.png`;
    lines.push(`#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}"${logo ? ` tvg-logo="${logo}"` : ''} group-title="${group}" tvg-chno="${n}",${name}`);
    if (n === 6) lines.push(`#EXTVLCOPT:http-user-agent=${UA}`, `#EXTVLCOPT:http-referrer=${base}/`);
    lines.push(kind === 'hls' ? `${base}/iptv/live/${n}/index.m3u8` : `${base}/iptv/stream/${n}.ts`);
  });
  return lines.join('\r\n') + '\r\n';
}

const pad = (n) => String(n).padStart(2, '0');
// XMLTV time in a fixed offset (minutes east of UTC).
function xmltvTime(ms, off) {
  const d = new Date(ms + off * 60_000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 ${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function guide(now = Date.now(), base = '') {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="wicaby-mock-iptv">'];
  const ids = [...new Set(CHANNELS.map((c) => c[2]).filter(Boolean))];
  for (const id of ids) {
    const [name] = CHANNELS.find((c) => c[2] === id);
    out.push(`  <channel id="${id}"><display-name>${esc(name)}</display-name>${base ? `<icon src="${base}/iptv/logo/${CHANNELS.findIndex((c) => c[2] === id) + 1}.png"/>` : ''}</channel>`);
  }
  const from = Math.floor((now - 6 * HOUR) / HOUR) * HOUR;
  const to = now + 3 * 24 * HOUR;
  ids.forEach((id, ci) => {
    const group = CHANNELS.find((c) => c[2] === id)[1];
    const off = ci % 2 ? 0 : 120;
    let t = from;
    for (let k = 0; t < to; k++) {
      const len = [30, 60, 90, 45][(k + ci) % 4] * 60_000;
      const title = TITLES[group][(k + ci) % TITLES[group].length];
      out.push(
        `  <programme start="${xmltvTime(t, off)}" stop="${xmltvTime(t + len, off)}" channel="${id}"><title lang="fr">${esc(title)}</title>` +
          `<desc lang="fr">${esc(`${title} sur ${id}, programme fictif n° ${k + 1}.`)}</desc><category lang="fr">${esc(group)}</category></programme>`,
      );
      t += len;
    }
  });
  out.push('</tv>');
  return out.join('\n') + '\n';
}

// ---- Streams ----

function mpvExe() {
  const candidates = [process.env.MOCK_MPV, path.resolve(here, '../../vendor/mpv/mpv.com'), path.resolve(here, '../../vendor/mpv/mpv')].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? 'mpv';
}

const clips = new Map();
// The pattern's clip, encoded once (H.264 baseline in MPEG-TS, 640×360, 25 fps, no audio track at all).
function clip(pattern) {
  if (clips.has(pattern)) return clips.get(pattern);
  const dir = path.join(os.tmpdir(), 'wicaby-mock-iptv');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pattern}-${SEG_S}s.ts`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 10_000) {
    const r = spawnSync(
      mpvExe(),
      ['--no-config', '--ao=null', '--mute=yes', '--no-audio', `av://lavfi:${pattern}=size=640x360:rate=25:duration=${SEG_S}`, `--o=${file}`, '--of=mpegts', '--ovc=libx264', '--ovcopts=preset=veryfast,g=25,profile=baseline,pix_fmt=yuv420p'],
      { timeout: 60_000, stdio: 'ignore' },
    );
    if (r.status !== 0 || !fs.existsSync(file)) {
      clips.set(pattern, null);
      return null;
    }
  }
  const data = fs.readFileSync(file);
  clips.set(pattern, data);
  return data;
}

// ---- Server ----

export function createHandler(opts = {}) {
  const state = { hits: {}, userAgents: [], tags: [] };
  const now = opts.now ?? (() => Date.now());
  const hit = (k) => (state.hits[k] = (state.hits[k] ?? 0) + 1);
  const tag = (t) => state.tags.length < 500 && state.tags.push(t);
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const base = `http://${req.headers.host ?? '127.0.0.1'}`;
    const ua = req.headers['user-agent'] ?? '';
    if (!state.userAgents.includes(ua) && state.userAgents.length < 50) state.userAgents.push(ua);
    const p = url.pathname;
    let m;
    if (p === '/Mock/State') return send(res, 200, 'application/json', JSON.stringify(state));
    if (p === '/iptv/playlist.m3u' || p === '/iptv/playlist.m3u8') {
      hit('playlist');
      return send(res, 200, 'audio/x-mpegurl; charset=utf-8', '﻿' + playlist(base));
    }
    if (p === '/freeboxtv/playlist.m3u') {
      hit('freebox');
      const host = req.headers.host ?? '127.0.0.1';
      const fbx = [[201, '2 - France 2'], [203, '3 - France 3']].flatMap(([sv, name]) =>
        [['hd', 'HD'], ['sd', 'standard'], ['ld', 'bas débit']].map(([f, label]) => `#EXTINF:0,${name} (${label})\nrtsp://${host}/fbxtv_pub/stream?namespace=1&service=${sv}&flavour=${f}`),
      );
      return send(res, 200, 'audio/x-mpegurl', `#EXTM3U\n#FBX-X-SERVER-VERSION:2\n${fbx.join('\n')}\n`);
    }
    if (p === '/get.php') {
      hit('xtream');
      if (url.searchParams.get('username') !== 'wika' || url.searchParams.get('password') !== 's3cret') return send(res, 401, 'text/plain', 'bad credentials');
      return send(res, 200, 'audio/x-mpegurl', playlist(base));
    }
    if (p === '/iptv/guide.xml' || p === '/iptv/guide.xml.gz') {
      hit(p.endsWith('.gz') ? 'guide.gz' : 'guide');
      const xml = Buffer.from(guide(now(), base));
      return p.endsWith('.gz') ? send(res, 200, 'application/gzip', zlib.gzipSync(xml)) : send(res, 200, 'application/xml; charset=utf-8', xml);
    }
    if ((m = /^\/iptv\/logo\/(\d+)\.png$/.exec(p))) {
      const c = CHANNELS[+m[1] - 1];
      if (!c) return send(res, 404, 'text/plain', 'no logo');
      hit('logo');
      return send(res, 200, 'image/png', logoPng(c[5]));
    }
    if ((m = /^\/iptv\/(live\/(\d+)\/(index\.m3u8|seg-(\d+)\.ts)|stream\/(\d+)\.ts)$/.exec(p))) {
      const n = +(m[2] ?? m[5]);
      const c = CHANNELS[n - 1];
      if (!c) return send(res, 404, 'text/plain', 'no channel');
      if (n === 6 && ua !== UA) {
        tag(`UA-MISSING ${n}`);
        return send(res, 403, 'text/plain', 'user agent refused');
      }
      const data = clip(c[4]);
      if (!data) {
        tag('NO-MPV');
        return send(res, 503, 'text/plain', 'mpv unavailable: no stream');
      }
      if (m[3] === 'index.m3u8') {
        hit('hls');
        const seq = Math.floor(now() / (SEG_S * 1000));
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_S}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${seq}`];
        for (let s = seq; s < seq + 4; s++) lines.push('#EXT-X-DISCONTINUITY', `#EXTINF:${SEG_S}.0,`, `seg-${s}.ts`);
        return send(res, 200, 'application/vnd.apple.mpegurl', lines.join('\n') + '\n');
      }
      if (m[4]) {
        hit('segment');
        return send(res, 200, 'video/mp2t', data);
      }
      hit('ts');
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      // Loops the clip for 2 minutes, paced at about real time so a player sees a live stream.
      let sent = 0;
      const tick = () => {
        if (res.destroyed || sent >= 120 / SEG_S) return res.end();
        sent++;
        res.write(data, () => setTimeout(tick, sent === 1 ? 0 : SEG_S * 1000 - 200));
      };
      tick();
      res.on('close', () => (sent = Infinity));
      return;
    }
    tag(`UNMAPPED ${req.method} ${p}`);
    send(res, 404, 'text/plain', 'not found');
  };
  return { handler, state };
}

export function startMockIptv({ port = 0, host = '127.0.0.1', now } = {}) {
  const { handler, state } = createHandler({ now });
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(port, host, () => resolve({ server, state, port: server.address().port, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) })),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const port = Number(process.argv[2] ?? process.env.MOCK_IPTV_PORT ?? 8098);
  const m = await startMockIptv({ port });
  console.log(`Mock IPTV on http://127.0.0.1:${m.port}/iptv/playlist.m3u (Xtream: /get.php?username=wika&password=s3cret&type=m3u_plus)`);
}
