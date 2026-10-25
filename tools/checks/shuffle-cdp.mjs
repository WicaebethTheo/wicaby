#!/usr/bin/env node
// Shuffle screen (#18) end to end in the desktop app, against mock Emby:
//   1. Home's "Pick Something for Me" opens it (and the sidebar lists it);
//   2. Random: 5 posters and the details panel, whose synopsis is plain text (the mock's overviews are set to HTML);
//   3. R and Shuffle Again draw a new set;
//   4. Library mode lists that library's films only; Genre mode offers one merged "Science-fiction" (movie-x0 and
//      movie-x8 are set to the "Science Fiction" spelling) and lists its titles, both spellings over two sets;
//   5. Enter on a poster opens its item page, and Back finds Genre mode again.
//
// Not part of run-all: it needs Electron and the built app (npm run build -w apps/desktop). Nothing plays and nothing
// leaves loopback. Ports: SHUFFLE_MOCK_PORT (8878), SHUFFLE_CDP_PORT (9778). Exit 1 on any failure.
//
//   node tools/checks/shuffle-cdp.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const MOCK_PORT = Number(process.env.SHUFFLE_MOCK_PORT ?? 8878);
const CDP_PORT = Number(process.env.SHUFFLE_CDP_PORT ?? 9778);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-shuffle-'));
const MOCK = `http://127.0.0.1:${MOCK_PORT}/emby`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), console.log('[shuffle]', results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.SHUFFLE_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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
  // Trusted key presses: a synthetic Enter would not follow a link.
  const press = async (key, code, vk, text) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  return { evaluate, press, close: () => ws.close() };
}

// The mock's overviews as HTML (tags, entities, paragraphs) and a second spelling of Science-fiction, through its
// metadata editor (POST /Items/{id}), before the app starts.
const HTML_OVERVIEW = '<p>Une <b>soirée</b> &amp; un film&nbsp;: rien <i>ne</i> va&hellip;</p><p>Deuxième&#160;paragraphe.</p>';
async function seedMock() {
  const auth = { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="shuffle-cdp", Device="check", DeviceId="shuffle-cdp", Version="1"' };
  const { AccessToken: token, User } = await (await fetch(`${MOCK}/Users/AuthenticateByName`, { method: 'POST', headers: auth, body: js({ Username: 'Wika', Pw: 'wicaby' }) })).json();
  const { Items } = await (await fetch(`${MOCK}/Users/${User.Id}/Items?IncludeItemTypes=Movie,Series&Recursive=true&api_key=${token}`)).json();
  for (const it of Items) {
    const Genres = it.Id === 'movie-x0' || it.Id === 'movie-x8' ? ['Science Fiction'] : undefined;
    const r = await fetch(`${MOCK}/Items/${it.Id}?api_key=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: js({ Name: it.Name, Overview: HTML_OVERVIEW, ...(Genres ? { Genres } : {}) }) });
    if (!r.ok) throw new Error(`seed ${it.Id}: ${r.status}`);
  }
  return Items.length;
}

// What the screen shows: the posters' item ids, the selected mode, the details panel.
const SCREEN = `(() => {
  const s = document.querySelector('.shuffle');
  if (!s) return null;
  const d = s.querySelector('.details');
  return {
    ids: [...s.querySelectorAll('.row .pick a.cover')].map((a) => a.getAttribute('href').split('/').pop()),
    busy: s.querySelector('.row')?.getAttribute('aria-busy') === 'true',
    mode: s.querySelector('.seg [role=radio][aria-checked=true]')?.textContent.trim(),
    pickers: [...s.querySelectorAll('.controls .pill')].map((b) => [b.getAttribute('aria-label'), b.textContent.trim()]),
    title: d?.querySelector('h2')?.textContent.trim(),
    meta: d ? [...d.querySelectorAll('.meta span')].map((m) => m.textContent.trim()) : [],
    genres: d?.querySelector('.genres')?.textContent.trim(),
    overview: d?.querySelector('.overview')?.textContent,
    empty: s.querySelector('.empty h2')?.textContent.trim(),
  };
})()`;
const screen = (main) => main.evaluate(SCREEN);
const settled = (main, n = 1) => until('a set', () => screen(main).then((s) => s && !s.busy && s.ids.length >= n && s), 20000);
const newSet = (main, before) => until('a new set', () => screen(main).then((s) => s && !s.busy && s.ids.length && s.ids.join() !== before.join() && s), 10000).catch(() => null);
// Each pick's details (type, genres) by pointing at it, as the mouse would.
const DETAILS_OF_ALL = `(async () => {
  const out = [];
  for (const p of document.querySelectorAll('.shuffle .row .pick')) {
    p.dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise((r) => requestAnimationFrame(() => r()));
    const d = document.querySelector('.shuffle .details');
    out.push({ type: d.querySelector('.meta span')?.textContent.trim(), genres: d.querySelector('.genres')?.textContent.trim() ?? '' });
  }
  return out;
})()`;
// Opens a picker and chooses the first option matching the pattern.
const pick = (label, pattern) => `(async () => {
  const pill = [...document.querySelectorAll('.shuffle .controls .pill')].find((b) => b.getAttribute('aria-label') === ${js(label)});
  if (!pill) return null;
  pill.click();
  for (let i = 0; i < 40 && !pill.parentElement.querySelector('[role=menuitemradio]'); i++) await new Promise((r) => setTimeout(r, 50));
  const opts = [...pill.parentElement.querySelectorAll('[role=menuitemradio]')];
  const names = opts.map((o) => o.textContent.trim());
  const hit = opts.find((o) => new RegExp(${js(pattern)}, 'i').test(o.textContent.trim()));
  hit?.click();
  return { names, picked: hit?.textContent.trim() };
})()`;
const mode = (label) => `(() => { const b = [...document.querySelectorAll('.shuffle .seg [role=radio]')].find((x) => x.textContent.trim() === ${js(label)}); b?.click(); return !!b; })()`;

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
  await until('mock', async () => (await fetch(`${MOCK}/System/Info/Public`)).ok);
  console.log('[shuffle] seeded', await seedMock(), 'titles');
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

  // 1. Home's entry.
  const entry = await until('home button', () => main.evaluate(`!!document.querySelector('.home .discover button')`), 30000);
  ok('sidebar lists Shuffle', await main.evaluate(`[...document.querySelectorAll('nav a, nav button, aside a, aside button')].some((b) => b.textContent.trim() === 'Shuffle')`));
  await main.evaluate(`document.querySelector('.home .discover button').click()`);
  const hash = await until('shuffle route', () => main.evaluate('location.hash').then((h) => h.startsWith('#/shuffle') && h), 10000);
  ok('Home button opens Shuffle', entry && !!hash, hash);

  // 2. Random.
  const rnd = await settled(main, 5);
  ok('random: 5 posters, Random mode', rnd.ids.length === 5 && rnd.mode === 'Random', js({ ids: rnd.ids, mode: rnd.mode }));
  const ov = rnd.overview ?? '';
  ok('details panel: title and meta', !!rnd.title && rnd.meta.length >= 2, `${rnd.title} · ${rnd.meta.join(' · ')}`);
  ok('synopsis is clean text', ov.startsWith('Une soirée & un film') && ov.includes('va…\n') && ov.includes('Deuxième paragraphe.') && !/[<>]|&\w+;|&#/.test(ov), js(ov));

  // 3. R, then the button.
  await main.evaluate(`document.activeElement?.blur(), true`);
  await main.press('r', 'KeyR', 82, 'r');
  const afterR = await newSet(main, rnd.ids);
  ok('R draws a new set', !!afterR, afterR ? js(afterR.ids) : 'same set');
  const base = afterR ?? rnd;
  await main.evaluate(`document.querySelector('.shuffle .reroll').click()`);
  const afterBtn = await newSet(main, base.ids);
  ok('Shuffle Again draws a new set', !!afterBtn, afterBtn ? js(afterBtn.ids) : 'same set');

  // 4a. Library mode: the first video library (Films), films only.
  ok('Library mode', await main.evaluate(mode('Library')));
  const lib = await until('library set', () => screen(main).then((s) => s && !s.busy && s.mode === 'Library' && s.pickers.some(([l]) => l === 'Library') && s.ids.length && s), 20000);
  const libDetails = await main.evaluate(DETAILS_OF_ALL);
  const libPicker = lib.pickers.find(([l]) => l === 'Library')?.[1];
  ok('Library: Films, films only', libPicker === 'Films' && libDetails.every((d) => d.type === 'Movie'), `${libPicker}: ${libDetails.map((d) => d.type).join(', ')}`);

  // 4b. Genre mode: one merged Science-fiction.
  ok('Genre mode', await main.evaluate(mode('Genre')));
  await until('genre picker', () => screen(main).then((s) => s?.mode === 'Genre' && s.pickers.some(([l]) => l === 'Genre')), 20000);
  const opened = await main.evaluate(pick('Genre', '^science.?fiction$'));
  const sciNames = opened?.names.filter((n) => /^science.?fiction$/i.test(n)) ?? [];
  ok('Genre: one merged Science-fiction option', sciNames.length === 1 && !!opened?.picked, js(opened?.names));
  const SCI = ['Science-fiction', 'Science Fiction'];
  const g1 = await until('genre set', () => screen(main).then((s) => s && !s.busy && s.pickers.some(([l, v]) => l === 'Genre' && v === sciNames[0]) && s.ids.length && s), 20000);
  const d1 = await main.evaluate(DETAILS_OF_ALL);
  await main.evaluate(`document.querySelector('.shuffle .reroll').click()`);
  const g2 = (await newSet(main, g1.ids)) ?? g1;
  const d2 = await main.evaluate(DETAILS_OF_ALL);
  const seen = [...d1, ...d2].map((d) => d.genres);
  ok('Genre: every pick is Science-fiction, both spellings', seen.every((g) => SCI.some((s) => g.includes(s))) && seen.some((g) => g.includes('Science Fiction')) && seen.some((g) => g.includes('Science-fiction')), js(seen));

  // 5. Enter opens the item page; Back keeps Genre.
  const target = g2.ids[0];
  await main.evaluate(`document.querySelector('.shuffle .row .pick a.cover').focus(), true`);
  await main.press('Enter', 'Enter', 13, '\r');
  const itemHash = await until('item page', () => main.evaluate('location.hash').then((h) => h.includes('/item/') && h), 10000).catch(() => null);
  ok('Enter opens the item page', itemHash === `#/item/${SERVER_ID}/${target}`, itemHash ?? 'no navigation');
  await main.evaluate(`history.back(), true`);
  const back = await until('back on shuffle', () => main.evaluate('location.hash').then((h) => h.startsWith('#/shuffle')).then((on) => on && screen(main)).then((s) => s && !s.busy && s.ids.length && s), 15000).catch(() => null);
  const backGenre = back?.pickers.find(([l]) => l === 'Genre')?.[1];
  ok('Back keeps Genre mode and its genre', back?.mode === 'Genre' && backGenre === sciNames[0], js({ mode: back?.mode, genre: backGenre }));

  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[shuffle] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
