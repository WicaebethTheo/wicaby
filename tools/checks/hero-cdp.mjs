#!/usr/bin/env node
// Featured banner (#19) end to end in the desktop app, against mock Emby:
//   1. Automatic: what is in progress (at most 5), with previous / next arrows and no shuffle button;
//   2. Random, 10 titles, films only, Action excluded: 10 slides, none of them Action or a show, a shuffle button,
//      and the shuffle and the arrows change the slide shown;
//   3. Settings > Home and libraries: the Featured Banner group lists the sources and opens the genre sheet.
//
// Not part of run-all: it needs Electron and the built app (npm run build:renderer and build:main in apps/desktop).
// Nothing plays and nothing leaves loopback. Ports: HERO_MOCK_PORT (8877), HERO_CDP_PORT (9777). Exit 1 on any failure.
//
//   node tools/checks/hero-cdp.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const MOCK_PORT = Number(process.env.HERO_MOCK_PORT ?? 8877);
const CDP_PORT = Number(process.env.HERO_CDP_PORT ?? 9777);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-hero-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), console.log('[hero]', results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.HERO_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
}
function kill(c) {
  if (c.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
  else c.kill('SIGKILL');
}
async function until(what, fn, timeoutMs = 30000, every = 150) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out: ${what}${last ? `: ${last.message}` : ''}`);
}

// Preloaded into main: Chromium reaches loopback only, and windows never take focus or the mouse.
const GUARD = String.raw`'use strict';
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
`;

async function attach() {
  const page = await until('page', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1')), 90000, 300);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => (ws.addEventListener('open', res, { once: true }), ws.addEventListener('error', rej, { once: true })));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

// What the banner shows: each slide's title (logo alt or heading) and meta line, the shown one, its controls.
const HERO = `(() => {
  const h = document.querySelector('.hero');
  if (!h) return null;
  const slides = [...h.querySelectorAll('.slide')].map((s) => ({ title: s.querySelector('.logo')?.alt ?? s.querySelector('.title')?.textContent?.trim(), meta: [...s.querySelectorAll('.meta span')].map((m) => m.textContent.trim()), active: s.classList.contains('active') }));
  return { slides, active: slides.find((s) => s.active)?.title, arrows: h.querySelectorAll('.pager .arrow').length, shuffle: !!h.querySelector('.slide.active .shuffle'), dots: h.querySelectorAll('.dot').length };
})()`;

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'en', reduceMotion: true, heroAutoplay: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach();
  await until('session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);
  await main.evaluate(`location.hash = '#/home'`);

  // 1. Automatic.
  const auto = await until('automatic banner', () => main.evaluate(HERO).then((h) => h?.slides.length && h), 30000);
  ok('automatic: up to 5 titles, arrows, no shuffle', auto.slides.length <= 5 && auto.arrows === 2 && !auto.shuffle, js({ n: auto.slides.length, arrows: auto.arrows, shuffle: auto.shuffle }));

  // 2. Random, films only, Action out.
  await main.evaluate(`wicaby.settings.update({ ui: { hero: { source: 'random', count: 10, types: 'movies', excludeGenres: ['Action'] } } }).then(() => true)`);
  const rnd = await until('random banner', () => main.evaluate(HERO).then((h) => h?.shuffle && h.slides.length === 10 && h), 30000);
  const action = rnd.slides.filter((s) => s.meta.includes('Action') || !s.meta.includes('Movie'));
  ok('random: 10 films, none of them Action', action.length === 0 && rnd.dots === 10, js(action));
  const first = rnd.active;
  await main.evaluate(`document.querySelectorAll('.hero .pager .arrow')[1].click()`);
  const next = await until('next slide', () => main.evaluate(HERO).then((h) => h.active !== first && h.active), 5000).catch(() => null);
  ok('next arrow moves on', !!next, `${first} -> ${next}`);
  await main.evaluate(`document.querySelectorAll('.hero .pager .arrow')[0].click()`);
  ok('previous arrow comes back', (await main.evaluate(HERO)).active === first);
  const set = (h) => h.slides.map((s) => s.title).join('|');
  const before = set(rnd);
  await main.evaluate(`document.querySelector('.hero .slide.active .shuffle').click()`);
  const after = await until('new set', () => main.evaluate(HERO).then((h) => set(h) !== before && h), 10000).catch(() => null);
  ok('shuffle draws a new set', !!after, after ? `${after.slides.length} titles` : 'same set');
  ok('shuffle keeps focus on the banner', await main.evaluate(`!!document.activeElement?.closest('.hero')`));

  // 3. Settings.
  await main.evaluate(`location.hash = '#/settings?pane=library'`);
  const group = await until('settings group', () => main.evaluate(`[...document.querySelectorAll('.gh')].some((h) => h.textContent === 'Featured Banner') && document.querySelectorAll('.link-row').length`), 15000);
  ok('settings: Featured Banner group with its pickers', group >= 4, `${group} link rows`);
  await main.evaluate(`[...document.querySelectorAll('.link-row')].find((b) => b.textContent.includes('Excluded Genres')).click()`);
  const genres = await until('genre sheet', () => main.evaluate(`[...document.querySelectorAll('.choices li')].map((l) => [l.textContent.trim(), l.querySelector('[role=switch]').getAttribute('aria-checked')])`).then((l) => l.length && l), 10000);
  const action2 = genres.find(([g]) => g === 'Action');
  ok('genre sheet: Action is switched on, no book genre', action2?.[1] === 'true' && !genres.some(([g]) => g === 'Bande dessinée'), js(genres.slice(0, 4)));

  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[hero] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
