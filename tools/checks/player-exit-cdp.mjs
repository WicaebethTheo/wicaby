#!/usr/bin/env node
// Leaving the player, frame by frame (desktop, Windows). Not part of run-all: it needs Electron, mpv
// (vendor/mpv), a silent video and the screen: the windows show, inactive, at EXITCDP_BOUNDS, which no other
// window may cover.
//
// Opens an item page of the demo mock, scrolls it, plays the film (muted, silent file), clicks the OSD's back
// button, and captures the screen every ~16 ms from each click until settled (screen-frames.ps1). Each frame is
// compared with the item page before playback, the video just before the click and an orange window kept behind
// the app (anything that shows what is behind the app shows orange).
// Fails on a near-white frame, on a frame showing the desktop, on an item page that remounted, scrolled or lost
// its focus, or on a page that is not back within 1.2 s. mpv: also fails when the player does not open windowed in
// the main window's place (its work area when --maximized), or the main window does not come back in it.
//
//   node tools/checks/player-exit-cdp.mjs [--player=mpv|html] [--reduce] [--maximized] [--video=<silent.mkv>] [--out=<dir>] [--keep]
//
// Ports: EXITCDP_MOCK_PORT (8861), EXITCDP_DEV_PORT (5601), EXITCDP_CDP_PORT (9761).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const PLAYER = args.player === 'html' ? 'html' : 'mpv';
const VIDEO = path.resolve(typeof args.video === 'string' ? args.video : path.join(ROOT, '.dev', 'pbux-silent.mkv'));
const OUT = path.resolve(typeof args.out === 'string' ? args.out : fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-exit-frames-')));
const MOCK_PORT = Number(process.env.EXITCDP_MOCK_PORT) || 8861;
const DEV_PORT = Number(process.env.EXITCDP_DEV_PORT) || 5601;
const CDP_PORT = Number(process.env.EXITCDP_CDP_PORT) || 9761;
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FILM = 'movie-1';
// Where the windows open: pick a spot no other window covers (the capture reads the screen). EXITCDP_BOUNDS=x,y,w,h.
const [bx, by, bw, bh] = (process.env.EXITCDP_BOUNDS ?? '200,120,1280,800').split(',').map(Number);
const BOUNDS = { x: bx, y: by, width: bw, height: bh };
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-exitcdp-'));
const FRAMES_PS1 = path.join(ROOT, 'tools', 'checks', 'screen-frames.ps1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[exit-cdp]', ...m);
const js = (v) => JSON.stringify(v);

const children = [];
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.EXITCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

async function until(what, fn, timeoutMs = 30000, everyMs = 100) {
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

// Loopback UDP only, and windows that never take the focus or the mouse (same guard as livetv-zap-cdp.mjs).
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
      // A dead proxy: Chromium and net.fetch reach loopback only (the update check, map tiles…).
      m.app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    }
    return m;
  };
}
`;

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(
    path.join(PROFILE, 'settings.json'),
    js({ ui: { language: 'fr', reduceMotion: Boolean(args.reduce), heroAutoplay: false, reduceTransparency: true }, windows: { trayHintShown: true }, window: { bounds: BOUNDS, maximized: Boolean(args.maximized) }, playback: { player: PLAYER } }),
  );
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

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
  ws.addEventListener('close', () => {
    for (const done of pending.values()) done({ error: { message: 'the page went away' } });
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => pending.has(i) && (pending.delete(i), reject(new Error(`${method}: no answer in 30 s`))), 30000);
      pending.set(i, (m) => (clearTimeout(timer), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { call, evaluate, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

let rect;
function capture(mode, out, extra = []) {
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FRAMES_PS1, '-Mode', mode, '-X', rect.x, '-Y', rect.y, '-W', rect.w, '-H', rect.h, '-Out', out, ...extra].map(String);
  return spawn('powershell', argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
}
// Starts a capture; `ready` once it grabs, `frames` (one JSON row each) once it is over.
function record(name, durationMs, refs) {
  const dir = path.join(OUT, `frames-${name}`);
  const cap = capture('seq', dir, ['-DurationMs', String(durationMs), '-Refs', refs.join(',')]);
  const list = [];
  let ready;
  const lines = readline.createInterface({ input: cap.stdout });
  return {
    ready: new Promise((resolve) => {
      ready = resolve;
      lines.on('line', (line) => (line.startsWith('READY') ? ready() : line.startsWith('{') && list.push(JSON.parse(line))));
    }),
    frames: new Promise((resolve) => cap.on('exit', () => resolve(list))),
  };
}
const single = (file) => new Promise((resolve, reject) => capture('single', file).on('exit', (c) => (c ? reject(new Error(`capture exited ${c}`)) : resolve(file))));

// Item page state that must survive the round trip.
const PAGE_STATE = `(() => {
  const sc = document.getElementById('main-scroller');
  const a = document.activeElement;
  return {
    route: location.hash,
    probe: sc?.firstElementChild?.dataset.exitProbe ?? null,
    scroll: sc ? Math.round(sc.scrollTop) : null,
    focus: a && a !== document.body ? a.tagName + '.' + [...a.classList].join('.') + ':' + (a.textContent ?? '').trim().slice(0, 30) : null,
    skeletons: document.querySelectorAll('.skeleton').length,
    visible: document.visibilityState,
  };
})()`;

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows only (screen capture through GDI)');
  if (!fs.existsSync(VIDEO)) throw new Error(`${VIDEO} is missing (silent test video; pass --video=)`);
  for (const p of [MOCK_PORT, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);
  fs.mkdirSync(OUT, { recursive: true });
  rect = { x: BOUNDS.x, y: BOUNDS.y, w: BOUNDS.width, h: BOUNDS.height };
  // An orange window behind the app: whatever shows the desktop shows orange.
  children.push(capture('backdrop', 'none'));
  await sleep(1500);
  const deskRef = await single(path.join(OUT, 'ref-desktop.png'));

  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT), VIDEO], { cwd: ROOT, env: { ...process.env, MOCK_DATASET: 'demo', NODE_OPTIONS: '' } });
  await until('the mock server', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => isApp(t) && !t.url.includes('osd=1'));
  await until('the session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in failed (${status})`);
  const dpr = await main.evaluate('devicePixelRatio');
  const OUTER = '({ x: screenX, y: screenY, width: outerWidth, height: outerHeight })';
  const mainBefore = await main.evaluate(OUTER);
  const win = args.maximized ? mainBefore : BOUNDS;
  rect = { x: Math.round(win.x * dpr), y: Math.round(win.y * dpr), w: Math.round(win.width * dpr), h: Math.round(win.height * dpr) };
  // Every maximize / fullscreen change of the main window from here on.
  await main.evaluate(`(window.__exitStates = [], wicaby.window.onState((s) => window.__exitStates.push(s)), true)`);

  // The item page, scrolled a little, its Play button focused and a probe that a remount would drop.
  await main.evaluate(`location.hash = '#/item/${SERVER_ID}/${FILM}'`);
  await until('the item page', () => main.evaluate(`!!document.querySelector('button.btn.light.lg') && !document.querySelector('.skeleton')`), 20000);
  await sleep(1500);
  await main.evaluate(`(() => { const sc = document.getElementById('main-scroller'); sc.scrollTop = 140; sc.firstElementChild.dataset.exitProbe = '1'; document.querySelector('button.btn.light.lg').focus(); })()`);
  await sleep(400);
  const before = await main.evaluate(PAGE_STATE);
  const pageRef = await single(path.join(OUT, 'ref-page.png'));
  log('item page', js(before));

  await main.evaluate(`wicaby.playback.command({ type: 'mute', value: true }).then(() => true)`);
  // The way in, captured too: no white or desktop frame there either.
  const opening = record('open', 2500, [pageRef, deskRef]);
  await opening.ready;
  const playAt = Date.now();
  await main.evaluate(`document.querySelector('button.btn.light.lg').click()`);
  // A resume question (the mock may hold a position): resume.
  await sleep(600);
  await main.evaluate(`document.querySelector('.resume button.btn.primary, [data-autofocus].btn.primary')?.click()`).catch(() => undefined);
  const openFrames = await opening.frames;
  await until('playback', () => main.evaluate(`wicaby.playback.getState().then((s) => s.active && !s.buffering && s.positionMs > 1500)`), 30000, 150);
  const osd = PLAYER === 'mpv' ? await attach((t) => isApp(t) && t.url.includes('osd=1')) : main;
  await until('the OSD', () => osd.evaluate(`document.visibilityState === 'visible' && !!document.querySelector('header.top button.round')`), 15000);
  await sleep(1200);
  // Playback looks like it happens in the main window (window-geometry.ts): same place, windowed.
  const placed = [];
  if (PLAYER === 'mpv') {
    const at = await osd.evaluate(`({ ...${OUTER}, avail: { x: screen.availLeft, y: screen.availTop, width: screen.availWidth, height: screen.availHeight } })`);
    const want = args.maximized ? at.avail : BOUNDS;
    if (['x', 'y', 'width', 'height'].some((k) => Math.abs(at[k] - want[k]) > 1)) placed.push(`the player opened at ${js(at)}, not ${js(want)}`);
    if (await main.evaluate('wicaby.playback.getState().then((s) => s.fullscreen)')) placed.push('the player opened in full screen');
  }
  const videoRef = await single(path.join(OUT, 'ref-video.png'));

  // Capture, then click the back button once the capture runs.
  const exit = record('exit', 1600, [pageRef, deskRef, videoRef]);
  await exit.ready;
  await sleep(80);
  const box = await osd.evaluate(`(() => { const r = document.querySelector('header.top button.round').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await osd.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  const clickAt = Date.now();
  await osd.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await osd.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  const frames = await exit.frames;
  await sleep(300);
  const after = await main.evaluate(PAGE_STATE);
  const stateAfter = await main.evaluate(`wicaby.playback.getState().then((s) => s.active)`);

  // Timelines: what each frame looks most like. Orange already in the picture or the page (backdrop art) is not
  // the backdrop.
  const failures = [...placed];
  const mainAfter = await main.evaluate(OUTER);
  if (['x', 'y', 'width', 'height'].some((k) => Math.abs(mainAfter[k] - mainBefore[k]) > 1)) failures.push(`the main window came back at ${js(mainAfter)}, not ${js(mainBefore)}`);
  const timeline = (name, list, t0) => {
    const keyBase = Math.max(list[0]?.key ?? 0, list.at(-1)?.key ?? 0) + 0.02;
    const rows = list.map((f) => {
      const [page, desk, video = Infinity] = f.mad;
      const kind = f.white > 0.3 ? 'WHITE' : desk < 7 || f.key > keyBase ? 'DESKTOP' : page < 7 ? 'page' : f.black > 0.97 ? 'black' : video < 7 ? 'video' : 'blend';
      return { ms: Math.round(f.t - t0), kind, luma: f.luma, black: f.black, key: f.key, page, video, desk, file: f.file };
    });
    for (const r of rows) {
      if (r.kind === 'WHITE') failures.push(`${name} ${r.ms} ms: near-white frame (${r.file})`);
      if (r.kind === 'DESKTOP' && r.ms > 0) failures.push(`${name} ${r.ms} ms: the desktop shows through (${r.file})`);
    }
    const lines = rows.map((r) => `${String(r.ms).padStart(6)} ms  ${r.kind.padEnd(7)} luma ${String(r.luma).padStart(5)}  black ${r.black.toFixed(2)}  orange ${r.key.toFixed(2)}  Δpage ${String(r.page).padStart(5)}  Δvideo ${String(r.video).padStart(5)}  Δdesk ${String(r.desk).padStart(5)}  ${path.relative(OUT, r.file)}`);
    fs.writeFileSync(path.join(OUT, `${name}-timeline.txt`), `${PLAYER}${args.reduce ? ' reduced motion' : ''}, ${name}: click at 0 ms\n${lines.join('\n')}\n`);
    log(`${name}:`);
    for (const l of lines) console.log(l);
    return rows;
  };
  timeline('open', openFrames, playAt);
  const rows = timeline('exit', frames, clickAt);
  log(`frames in ${OUT}`);
  const settled = rows.find((r, i) => r.ms > 0 && rows.slice(i).every((x) => x.kind === 'page'));
  if (!settled || settled.ms > 1200) failures.push(`the page is not back and steady within 1.2 s (${settled ? `${settled.ms} ms` : 'never'})`);
  if (stateAfter) failures.push('playback still active');
  for (const k of ['route', 'probe', 'scroll', 'focus']) if (js(before[k]) !== js(after[k])) failures.push(`item page ${k}: ${js(before[k])} → ${js(after[k])}`);
  if (after.skeletons) failures.push(`${after.skeletons} skeleton(s) on the page after the exit`);
  const states = await main.evaluate('window.__exitStates');
  const flips = states.filter((s) => s.maximized !== Boolean(args.maximized) || s.fullscreen);
  if (flips.length) failures.push(`the main window left its state on the way: ${js(flips)}`);
  log('item page after', js(after));
  for (const f of failures) log(`  ✗ ${f}`);
  log(failures.length ? `${failures.length} problem(s)` : `ok: page back and steady at ${settled.ms} ms, no white or desktop frame, page kept`);
  osd.close();
  if (osd !== main) main.close();
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  console.error('[exit-cdp]', err.message);
}
if (args.keep) {
  log(`kept running: CDP ${CDP_PORT}, mock ${MOCK_PORT}; Ctrl+C stops`);
  await new Promise(() => undefined);
}
stopAll();
await sleep(500);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {
  // Electron may still hold a file for a moment.
}
process.exit(code);
