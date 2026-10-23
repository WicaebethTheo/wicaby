// Player check: the remux player end to end in a real MSE engine. Playwright's WebKit build on Windows has no
// MediaSource, so this drives an installed Chromium browser with the proprietary codecs (PLAYER_BROWSER, else
// Brave or Chrome where they install), on a fresh temporary profile: its MediaSource takes what the phone's
// ManagedMediaSource takes, as far as its codecs go. For each MKV of .dev/media it serves the file from the mock
// Emby server, signs in, plays a film from its page, and checks that:
// - the player says it remuxes on the phone (no server conversion),
// - the picture advances, then a seek far ahead plays on from there,
// - no page error was raised.
// PLAYER_OFFLINE=1: the film is downloaded first, the server is then stopped, and it plays from the Downloads tab
// (lib/downloads: the file from the phone, the page and PlaybackInfo from what was kept).
//   node apps/mobile-web/scripts/player-check.mjs [file.mkv…]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const APP = path.resolve(import.meta.dirname, '..');
const MEDIA = path.join(ROOT, '.dev', 'media');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startMock(port, video) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(port), video], {
    env: { ...process.env, MOCK_DATASET: 'demo', MOCK_DURATION_S: '30', ...(process.env.PLAYER_PGS ? { MOCK_PGS: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-emby: not listening after 10 s')), 10_000);
    child.stdout.on('data', (d) => /Mock Emby/i.test(String(d)) && (clearTimeout(timer), resolve()));
    child.once('exit', (code) => reject(new Error(`mock-emby exited with ${code}`)));
  });
  return child;
}

const state = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video.app-video');
    return { t: v?.currentTime ?? -1, paused: v?.paused, err: v?.error?.message ?? null, mode: document.querySelector('.heading .footnote')?.textContent ?? '', msg: document.querySelector('.center .title-2')?.textContent ?? '' };
  });

const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(MEDIA).filter((f) => f.endsWith('.mkv'));
const vite = await createServer({ configFile: path.join(APP, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await vite.listen();
const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;
const CANDIDATES = [
  process.env.PLAYER_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('player-check: no Chromium browser with proprietary codecs found (set PLAYER_BROWSER)');
const browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
try {
  for (const name of files) {
    const port = await freePort();
    const mock = await startMock(port, path.join(MEDIA, name));
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    // iOS's ManagedMediaSource as the worst case: it never says "start streaming" (streaming stays false), so the
    // player must feed what it needs by itself (on a real iPhone it stays false until the buffer holds enough).
    await page.addInitScript(() => {
      class ManagedMediaSource extends MediaSource {
        get streaming() {
          return false;
        }
      }
      Object.defineProperty(window, 'ManagedMediaSource', { value: ManagedMediaSource });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => /^remux:/.test(m.text()) && errors.push(m.text()));
    if (process.env.PLAYER_DEBUG) page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 200)));
    try {
      await page.goto(appUrl);
      await page.getByRole('textbox').first().fill(`http://127.0.0.1:${port}`);
      await page.keyboard.press('Enter');
      await page.getByText('Wika', { exact: true }).click();
      await page.locator('input[type=password]').fill('wicaby');
      await page.keyboard.press('Enter');
      await page.locator('nav').waitFor();
      await page.waitForTimeout(800);
      const card = page.locator('[data-screen-top] section.shelf', { hasText: 'Movies' }).locator('button.card').first();
      if (process.env.PLAYER_OFFLINE) {
        await card.scrollIntoViewIfNeeded();
        const box = await card.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(700);
        await page.mouse.up();
        await page.locator('.sheet button.row', { hasText: 'Télécharger' }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('wicaby.downloads') ?? '[]')[0]?.status === 'done', null, { timeout: 60_000 });
        mock.kill();
        await page.locator('nav button').nth(2).click();
        await page.locator('[data-screen-top] button.main').first().click();
      } else {
        // A film from its page, from the start (a resume point could lie past the end of the short test file).
        await card.click();
        await page.locator('[data-screen-top] button.play').click();
      }
      await page.getByText(/Depuis le début|From the start/).click({ timeout: 2000 }).catch(() => {});
      if (process.env.PLAYER_DEBUG)
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(1000);
          console.log('  [debug]', i, JSON.stringify(await state(page)), await page.evaluate(() => location.hash + ' ' + document.querySelectorAll('[data-screen-top] .player').length));
        }
      await page.waitForTimeout(5000);
      // The controls hide while playing: a tap brings them (mode line, bar) back.
      const show = async () => {
        if (!(await page.locator('[data-screen-top] .player .bar').count())) await page.locator('[data-screen-top] .surface').click();
        await page.locator('[data-screen-top] .player .bar').waitFor({ timeout: 2000 });
      };
      await show();
      const a = await state(page);
      // PLAYER_PGS=1 (the file pgs-check.mjs makes): the PGS track picked in the tracks sheet must draw its
      // pictures over the video, with no reload of the session.
      let pgs = '';
      if (process.env.PLAYER_PGS) {
        const sessions = () => page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /PlaybackInfo/.test(r.name)).length);
        const before = await sessions();
        await show();
        await page.locator('.osd button', { hasText: /Audio et sous-titres/ }).click();
        await page.waitForTimeout(600);
        if (process.env.PLAYER_DEBUG) await page.screenshot({ path: path.join(ROOT, '.dev', 'shots', 'player-check-tracks.png') });
        await page.locator('.sheet button', { hasText: 'English PGS' }).click();
        await page.waitForTimeout(500);
        let seen = null;
        for (let i = 0; i < 16 && !seen; i++) {
          await page.waitForTimeout(250);
          seen = await page.evaluate(() => {
            const c = document.querySelector('.pictures canvas');
            if (!c || !c.width) return null;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let opaque = 0;
            for (let j = 3; j < d.length; j += 4) if (d[j] > 200) opaque++;
            const r = c.getBoundingClientRect();
            return { w: c.width, h: c.height, opaque, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
          });
        }
        const reloads = (await sessions()) - before;
        pgs = seen ? `PGS ${seen.w}x${seen.h} ${seen.opaque} opaque px at ${seen.box.join(',')}${reloads ? ` · ${reloads} reload(s)` : ''}` : 'PGS: no picture';
        if (!seen || !seen.opaque || reloads) errors.push(pgs);
        if (process.env.PLAYER_DEBUG) console.log('  [debug]', pgs);
        await page.locator('.scrim').first().click({ timeout: 1000 }).catch(() => {});
      }
      // A seek past what is buffered (the session's seek, as the bar does).
      await show();
      await page.locator('[data-screen-top] .player .bar').click({ position: { x: 300, y: 15 } });
      await page.waitForTimeout(4000);
      const b = await state(page);
      const remux = /remux/i.test(a.mode);
      const played = a.t > 0.5 && !a.paused;
      const sought = b.t > a.t + 3;
      const ok = remux && played && sought && !a.err && !b.err && !errors.length;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: "${a.mode}" · t ${a.t.toFixed(1)} s → after seek ${b.t.toFixed(1)} s${a.err || b.err ? ` · ${a.err ?? b.err}` : ''}${a.msg ? ` · ${a.msg}` : ''}${errors.length ? ` · ${errors.join(' | ')}` : ''}${pgs && !errors.length ? ` · ${pgs}` : ''}`);
    } catch (e) {
      failed++;
      await page.screenshot({ path: path.join(ROOT, '.dev', 'shots', 'player-check-fail.png') }).catch(() => {});
      console.log(`FAIL ${name}: ${e.message.split('\n').slice(0, 3).join(' ')}${errors.length ? ` · ${errors.join(' | ')}` : ''}`);
    } finally {
      await page.close();
      mock.kill();
    }
  }
} finally {
  await browser.close();
  await vite.close();
}
if (failed) {
  console.error(`player-check: ${failed} file(s) failed`);
  process.exit(1);
}
console.log('player-check: ok');
