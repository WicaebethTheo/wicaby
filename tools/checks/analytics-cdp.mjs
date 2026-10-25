#!/usr/bin/env node
// Administration → Analytics (issue #17) end to end in the built desktop app, on mock Emby with its music library:
//   1. the section scans every library (progress, then totals and buckets) and shows the scan date;
//   2. a library tab narrows the figures to that library;
//   3. a bucket opens its items, and an item opens the item page;
//   4. back on the section, the cached scan shows at once (no new scan).
//
// Not part of run-all: it needs Electron and a built app (npm run build in apps/desktop first). Nothing plays and
// nothing leaves loopback. ANALYTICS_SHOTS=<dir> saves screenshots.
//
//   node tools/checks/analytics-cdp.mjs     Ports: ANALYTICS_MOCK_PORT (8876), ANALYTICS_CDP_PORT (9776).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const MOCK_PORT = Number(process.env.ANALYTICS_MOCK_PORT ?? 8876);
const CDP_PORT = Number(process.env.ANALYTICS_CDP_PORT ?? 9776);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-analytics-'));
const SHOTS = process.env.ANALYTICS_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[analytics]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.ANALYTICS_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Preloaded into main: no proxy-less network, and windows that never take focus or the mouse.
const GUARD = String.raw`'use strict';
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

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

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
  const shot = async (name) => SHOTS && fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  return { evaluate, shot, close: () => ws.close() };
}

// Totals tiles as numbers ("1 234" in French).
const TOTALS = `[...document.querySelectorAll('.an .totals .num')].map((n) => n.textContent.replace(/\\D/g, ''))`;
const clickText = (selector, text) => `(() => { const b = [...document.querySelectorAll(${js(selector)})].find((x) => x.textContent.includes(${js(text)})); b?.click(); return !!b; })()`;

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_MUSIC: '1' } });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach();
  await until('session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // 1. Every library.
  await main.evaluate(`location.hash = '#/admin/${SERVER_ID}/analytics'`);
  const nav = await until('section', () => main.evaluate(`document.querySelector('.cats button[aria-current="page"]')?.textContent.trim()`), 20000);
  ok('the section is listed and open', nav === 'Statistiques', nav);
  const totals = await until('totals', async () => {
    const t = await main.evaluate(TOTALS);
    return t.length === 3 && t;
  }, 60000);
  ok('all libraries: items and libraries', totals[0] === '136' && totals[1] === '4', totals.join(' / '));
  const groups = await main.evaluate(`[...document.querySelectorAll('.an h3')].map((h) => h.textContent)`);
  ok('every group is shown', ['Types de médias', 'Résolution', 'Codecs vidéo', 'Codecs audio', 'Conteneurs', 'HDR', 'Sous-titres et langues', 'Par bibliothèque'].every((g) => groups.includes(g)), groups.join(', '));
  const when = await main.evaluate(`document.querySelector('.an .when')?.textContent ?? ''`);
  ok('the scan date shows', when.startsWith('Analysé le '), when);
  await main.shot('all');

  // 2. One library.
  ok('the Films tab', await main.evaluate(clickText('.an .top [role="radio"]', 'Films')));
  const films = await until('films totals', async () => {
    const t = await main.evaluate(TOTALS);
    return t[1] === '1' && t;
  }, 30000);
  ok('Films: its own figures', films[0] === '60', films.join(' / '));

  // 3. Drill-down, then the item page.
  ok('the AV1 bucket', await main.evaluate(clickText('.an .bucket', 'AV1')));
  const listed = await until('drill sheet', () => main.evaluate(`document.querySelectorAll('.drill .link-row').length`), 10000);
  const info = await main.evaluate(`document.querySelector('.drill .link-row')?.textContent ?? ''`);
  ok('the bucket lists its films with their streams', listed === 6 && info.includes('AV1') && info.includes('/media/movie-x'), `${listed} rows: ${info.trim().slice(0, 120)}`);
  await main.shot('drill');
  await main.evaluate(`document.querySelector('.drill .link-row').click()`);
  const hash = await until('item page', async () => {
    const h = await main.evaluate('location.hash');
    return h.includes('/item/') && h;
  }, 10000);
  ok('an item opens its page', hash.startsWith(`#/item/${SERVER_ID}/movie-x`), hash);

  // 4. Cached.
  await main.evaluate(`location.hash = '#/admin/${SERVER_ID}/analytics'`);
  const again = await until('cached totals', async () => {
    const t = await main.evaluate(TOTALS);
    return t.length === 3 && t;
  }, 10000);
  const scanning = await main.evaluate(`!!document.querySelector('.an .scan [role="progressbar"]')`);
  ok('back on the section: the cached scan, no new scan', again[0] === '136' && !scanning, `${again.join(' / ')}, scanning ${scanning}`);

  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[analytics] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
