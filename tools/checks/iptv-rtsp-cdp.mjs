#!/usr/bin/env node
// A Freebox TV (rtsp://…/fbxtv_pub/stream) IPTV channel in the desktop app (dev build, CDP): the picture must show.
// Not part of run-all: it needs Electron, mpv (vendor/mpv), MediaMTX and ffmpeg. Everything is local: MediaMTX on
// 127.0.0.1 serves an interlaced 1080i H.264 test pattern with a silent audio track over RTSP/UDP only (the box refuses
// TCP), a loopback HTTP server the Freebox-shaped playlist, the Emby mock the signed-in server; the app runs with
// WICABY_TEST_SILENT=1 in a throwaway profile.
//
//   IPTVRTSP_FFMPEG=<ffmpeg.exe> IPTVRTSP_MEDIAMTX=<mediamtx.exe> node tools/checks/iptv-rtsp-cdp.mjs [--audio=aac|mp2]
//
// No ac3: ffmpeg's RTSP SDP for it has no clock rate and MediaMTX refuses it (400).
// Skips (exit 0) without both paths. Fails when the channel plays as radio (the OSD's opaque radio card over mpv's
// picture: "only the sound"), when the opening veil stays up, or when mpv never reports the 1080 picture.
// Ports: 18554 (RTSP), 18000-18001 (RTP/RTCP), 8881 (Emby mock), 8882 (playlist), 5621 (Vite), 9781 (CDP).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const AUDIO = ['aac', 'mp2'].includes(args.audio) ? args.audio : 'aac';
const FFMPEG = process.env.IPTVRTSP_FFMPEG;
const MEDIAMTX = process.env.IPTVRTSP_MEDIAMTX;
const RTSP_PORT = 18554;
const MOCK_PORT = 8881;
const PL_PORT = 8882;
const DEV_PORT = 5621;
const CDP_PORT = 9781;
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[iptv-rtsp-cdp]', ...m);
const js = (v) => JSON.stringify(v);

if (!FFMPEG || !MEDIAMTX || !fs.existsSync(FFMPEG) || !fs.existsSync(MEDIAMTX)) {
  log('skipped: set IPTVRTSP_FFMPEG and IPTVRTSP_MEDIAMTX to an ffmpeg and a MediaMTX executable');
  process.exit(0);
}

const children = [];
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.IPTVRTSP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children.splice(0)) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}
process.on('SIGINT', () => (stopAll(), process.exit(130)));

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });

async function until(what, fn, timeoutMs = 30000, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

// One RTSP DESCRIBE: 200 once ffmpeg publishes the path.
const describe = () =>
  new Promise((resolve) => {
    const s = net.connect({ port: RTSP_PORT, host: '127.0.0.1' });
    let buf = '';
    s.setTimeout(2000, () => (s.destroy(), resolve(false)));
    s.on('data', (d) => ((buf += d), buf.includes('\r\n\r\n') && (s.destroy(), resolve(buf.startsWith('RTSP/1.0 200')))));
    s.on('error', () => resolve(false));
    s.on('connect', () => s.write(`DESCRIBE rtsp://127.0.0.1:${RTSP_PORT}/fbxtv_pub/stream RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`));
  });

// Keeps the windows from taking focus or the mouse, and UDP on loopback (tools/screenshots/desktop.mjs).
const GUARD = String.raw`'use strict';
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) { if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
if (process.versions.electron) {
  const Module = require('node:module');
  const load = Module._load;
  let hooked = false;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (!hooked && request === 'electron' && m && m.app) {
      hooked = true;
      m.app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    }
    return m;
  };
}
`;

async function attach(pick) {
  const page = await until('a Wicaby page', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && pick(t)), 90000, 300);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => (ws.addEventListener('open', resolve, { once: true }), ws.addEventListener('error', reject, { once: true })));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      // A hidden window's page may never answer.
      const timer = setTimeout(() => pending.delete(i) && reject(new Error('no answer in 10 s')), 10000);
      pending.set(i, (m) => {
        clearTimeout(timer);
        const r = m.result;
        if (m.error || r.exceptionDetails) reject(new Error(m.error?.message ?? r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        else resolve(r.result.value);
      });
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  return { evaluate, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

const failures = [];
const expect = (ok, what) => (ok ? log(`ok   ${what}`) : (failures.push(what), log(`FAIL ${what}`)));

async function run() {
  for (const p of [RTSP_PORT, MOCK_PORT, PL_PORT, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-iptvrtsp-'));

  // MediaMTX: RTSP over UDP only, on loopback, nothing else.
  const conf = path.join(work, 'mediamtx.yml');
  fs.writeFileSync(
    conf,
    [
      'logLevel: warn', 'api: false', 'metrics: false', 'pprof: false', 'playback: false', 'rtmp: false', 'hls: false', 'webrtc: false', 'srt: false', 'moq: false',
      'rtsp: true', 'rtspTransports: [udp]', 'rtspEncryption: "no"', `rtspAddress: 127.0.0.1:${RTSP_PORT}`, 'rtpAddress: 127.0.0.1:18000', 'rtcpAddress: 127.0.0.1:18001',
      'paths:', '  all_others:', '',
    ].join('\n'),
  );
  start(MEDIAMTX, [conf], { cwd: work });
  await until('MediaMTX', async () => !(await portFree(RTSP_PORT)), 15000);
  // A 1080i test pattern (H.264 field-coded, top field first) and a silent 48 kHz track, at real time.
  start(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-af', 'volume=0', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '25', '-flags', '+ildct+ilme', '-x264opts', 'tff=1',
    '-c:a', AUDIO, '-f', 'rtsp', '-rtsp_transport', 'udp', `rtsp://127.0.0.1:${RTSP_PORT}/fbxtv_pub/stream`,
  ], { cwd: work });
  await until('the published stream', describe, 20000, 500);
  log(`stream published (h264 1080i + ${AUDIO})`);

  // The Freebox playlist's shape: one entry per flavour, the query string the box needs (MediaMTX ignores it).
  const pl = http.createServer((_req, res) => {
    const entries = [[201, '2 - France 2'], [203, '3 - France 3']].flatMap(([sv, n]) =>
      [['hd', 'HD'], ['sd', 'standard'], ['ld', 'bas débit']].map(([f, l]) => `#EXTINF:0,${n} (${l})\nrtsp://127.0.0.1:${RTSP_PORT}/fbxtv_pub/stream?namespace=1&service=${sv}&flavour=${f}`),
    );
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end(`#EXTM3U\n#FBX-X-SERVER-VERSION:2\n${entries.join('\n')}\n`);
  });
  await new Promise((r) => pl.listen(PL_PORT, '127.0.0.1', r));

  try {
    const profile = path.join(work, 'profile');
    fs.mkdirSync(profile);
    const address = `http://127.0.0.1:${MOCK_PORT}`;
    fs.writeFileSync(path.join(profile, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Maison', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
    fs.writeFileSync(path.join(profile, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, reduceTransparency: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv' } }));
    const guard = path.join(profile, 'guard.cjs');
    fs.writeFileSync(guard, GUARD);
    start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, MOCK_LIVETV: 'off', NODE_OPTIONS: '' } });
    await until('the Emby mock', async () => (await fetch(`${address}/emby/System/Info/Public`)).ok);
    start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], {
      cwd: DESKTOP,
      env: { ...process.env, WICABY_TEST_SILENT: '1', WICABY_DEV_PORT: String(DEV_PORT), NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
    });
    const page = await attach((t) => isApp(t) && !t.url.includes('osd=1'));
    await until('the session', () => page.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
    if ((await page.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`)) !== 'signed-in') throw new Error('sign-in failed');

    const src = await page.evaluate(`wicaby.iptv.add({ playlist: 'http://127.0.0.1:${PL_PORT}/freeboxtv/playlist.m3u', name: 'Freebox TV' })`);
    expect(src.channels === 2, `Freebox playlist: one channel per service (${src.channels})`);
    const ch = await until('the channels', () => page.evaluate(`(async () => { const s = (await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv'); const r = s && await wicaby.api.get('/LiveTv/Channels', {}, s.server.id); return r?.Items?.length ? { sid: s.server.id, id: r.Items[0].Id } : null; })()`), 30000, 500);
    await page.evaluate(`wicaby.playback.play({ itemIds: [${js(ch.id)}], serverId: ${js(ch.sid)} }).then(() => true)`);
    const st = await until('mpv playing the channel', () => page.evaluate(`wicaby.playback.getState().then((s) => s.active && !s.buffering && s.positionMs > 2000 ? s : null)`), 45000, 500);
    expect(st.stats?.resolution === '1920×1080', `mpv decodes the picture (${st.stats?.resolution}, ${st.stats?.videoCodec})`);
    expect(!st.live?.radio, `the channel is not played as radio (live.radio=${st.live?.radio})`);

    const osd = await attach((t) => isApp(t) && t.url.includes('osd=1'));
    await sleep(1500);
    const dom = await osd.evaluate(`({ veil: document.querySelector('.veil')?.classList.contains('on'), cards: [...document.querySelectorAll('.card')].map((c) => c.className + ': ' + c.textContent.replace(/\\s+/g, ' ').trim()) })`);
    expect(dom.veil === false, `the opening veil is down (${dom.veil})`);
    expect(dom.cards.length === 0, `nothing opaque over the picture (${dom.cards.join(' | ') || 'no card'})`);
    osd.close();
    await page.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`).catch(() => undefined);
    await sleep(1000);
  } finally {
    stopAll();
    pl.close();
  }
  if (failures.length) {
    log(`${failures.length} failure(s)`);
    process.exit(1);
  }
  log('ok');
}

run().catch((err) => {
  console.error(err);
  stopAll();
  process.exit(1);
});
