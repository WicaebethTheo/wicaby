// Screenshots of the phone web app in WebKit (Playwright's build of Safari's engine), at an iPhone 15 Pro Max's
// size as a Home Screen app under the platform's status bar (index.html): 430 × 873 pt at 3× (932 less the 59 pt
// bar), touch, with its bottom safe area (34 pt) applied through the app's own --safe-* variables, since a desktop
// WebKit reports none. Runs against the mock Emby server
// (demo dataset) and the dev server, signs in once, then walks each scene. Fails on any page error or console error.
//
//   npm run shots -w apps/mobile-web [-- scene…]      scenes: login home homeScrolled detail series library folder
//                                                      search settings
//   SHOTS_VIDEO=.dev/media/x.mkv for the player scene; SHOTS_DARK=0 for the light scheme first; SHOTS_EVAL='<js expression>' prints its value on each scene (debug).
//   Output in .dev/shots/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT = path.join(ROOT, '.dev', 'shots');
const APP = path.resolve(import.meta.dirname, '..');
// iPhone 15 Pro Max insets, upright and on its side.
const SAFE = process.env.SHOTS_LANDSCAPE === '1' ? { top: 0, bottom: 21, left: 59, right: 59 } : { top: 0, bottom: 34, left: 0, right: 0 };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startMock(port) {
  // SHOTS_VIDEO: the file the mock serves for every title (the player scenes).
  const video = process.env.SHOTS_VIDEO ? [path.resolve(ROOT, process.env.SHOTS_VIDEO)] : [];
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(port), ...video], {
    env: { ...process.env, MOCK_DATASET: 'demo' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-emby: not listening after 10 s')), 10_000);
    child.stdout.on('data', (d) => /listening|Mock Emby/i.test(String(d)) && (clearTimeout(timer), resolve()));
    child.once('exit', (code) => reject(new Error(`mock-emby exited with ${code}`)));
  });
  return child;
}

// Scene: what to do from the signed-in Home before the screenshot.
const SCENES = {
  async home() {},
  async homeScrolled(page) {
    await page.locator('[data-screen-top] .scroller, [data-screen-top] [data-scroll]').first().evaluate((el) => el.scrollTo(0, 700));
    await page.waitForTimeout(500);
  },
  async profile(page) {
    await page.locator('[data-screen-top] button.me').first().click();
    await page.waitForTimeout(400);
  },
  async detail(page) {
    await page.locator('[data-screen-top] button.card').nth(2).click();
    await page.waitForTimeout(1200);
  },
  // A title's page scrolled: the artwork softening under the page, the titles fading, then the bar.
  async detailMid(page) {
    await SCENES.series(page);
    await page.locator('[data-screen-top] .scroller').evaluate((el) => el.scrollTo(0, 190));
    await page.waitForTimeout(700);
  },
  async detailLow(page) {
    await SCENES.series(page);
    await page.locator('[data-screen-top] .scroller').evaluate((el) => el.scrollTo(0, 420));
    await page.waitForTimeout(1200);
  },
  async series(page) {
    await page.locator('[data-screen-top] section.shelf', { hasText: 'TV Shows' }).locator('button.card').first().click();
    await page.waitForTimeout(1200);
  },
  async library(page) {
    await page.locator('nav button').nth(1).click();
    await page.waitForTimeout(800);
  },
  async folder(page) {
    await page.locator('nav button').nth(1).click();
    await page.waitForTimeout(500);
    await page.locator('[data-screen-top] button.lib').first().click();
    await page.waitForTimeout(1500);
  },
  // Libraries' tiles: favourites, collections; a person from a title's cast.
  async favorites(page) {
    await SCENES.library(page);
    await page.locator('[data-screen-top] button.tile').first().click();
    await page.waitForTimeout(1500);
  },
  async collections(page) {
    await SCENES.library(page);
    await page.locator('[data-screen-top] button.tile').nth(1).click();
    await page.waitForTimeout(1500);
  },
  async movie(page) {
    await SCENES.folder(page);
    await page.locator('[data-screen-top] button.card').first().click();
    await page.waitForTimeout(1500);
  },
  async person(page) {
    await SCENES.movie(page);
    await page.locator('[data-screen-top] button.person').first().click();
    await page.waitForTimeout(1500);
  },
  async search(page) {
    await page.locator('nav button').last().click();
    await page.waitForTimeout(500);
  },
  // A long press on the first Continue card: the title's menu.
  async itemMenu(page) {
    const card = page.locator('[data-screen-top] section.continue button.big').first();
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(900);
  },
  // A title's "…" on its page (the same menu), and its media info.
  async movieMore(page) {
    await SCENES.movie(page);
    await page.locator('[data-screen-top] .actions button.action').last().click();
    await page.waitForTimeout(900);
  },
  async mediaInfo(page) {
    await SCENES.movieMore(page);
    await page.locator('.sheet button.row', { hasText: 'Infos du média' }).click();
    await page.waitForTimeout(700);
  },
  // A Continue card plays; the controls stay up for the screenshot (a tap shows them).
  async player(page) {
    await page.locator('[data-screen-top] section.continue button.big').first().click();
    await page.waitForTimeout(6000);
  },
  // The player, then its audio and subtitles sheet, and its quality sheet.
  async playerTracks(page) {
    await SCENES.player(page);
    if (!(await page.locator('.osd').count())) await page.locator('[data-screen-top] .surface').click();
    await page.locator('.osd button', { hasText: /Audio et sous-titres|Audio and subtitles/ }).click();
    await page.waitForTimeout(600);
  },
  async playerQuality(page) {
    await SCENES.player(page);
    await page.locator('.osd button.wide').click();
    await page.waitForTimeout(600);
  },
  // Settings > Appearance (the theme cards, the accent swatches), and Playback.
  async appearance(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.row').nth(1).click();
    await page.waitForTimeout(800);
  },
  async homeSettings(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.row').nth(2).click();
    await page.waitForTimeout(800);
  },
  async appearanceLow(page) {
    await SCENES.appearance(page);
    await page.locator('[data-screen-top] [data-scroll]').evaluate((el) => el.scrollTo(0, 900));
    await page.waitForTimeout(600);
  },
  async playback(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.row').nth(3).click();
    await page.waitForTimeout(800);
  },
  async subtitlesPage(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.row').nth(4).click();
    await page.waitForTimeout(800);
  },
  async accounts(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.me.pressable:visible').first().click();
    await page.waitForTimeout(800);
  },
  async password(page) {
    await SCENES.accounts(page);
    await page.locator('[data-screen-top] button.row', { hasText: /mot de passe/i }).click();
    await page.waitForTimeout(800);
  },
  // Settings > Administration, then a few of its sections; a title's metadata editor from its menu.
  async admin(page) {
    await SCENES.settings(page);
    await page.locator('[data-screen-top] button.row', { hasText: 'Administration' }).click();
    await page.waitForTimeout(800);
  },
  ...Object.fromEntries(
    ['Tableau de bord', 'Utilisateurs', 'Bibliothèques', 'Tâches planifiées', 'Transcodage', 'Serveur', 'Activité', 'Journaux', 'Extensions', 'Appareils', 'Clés'].map((label, i) => [
      `admin${i}`,
      async (page) => {
        await SCENES.admin(page);
        await page.locator('[data-screen-top] button.row', { hasText: label }).first().click();
        await page.waitForTimeout(2000);
      },
    ]),
  ),
  async itemEdit(page) {
    await SCENES.itemMenu(page);
    await page.locator('.sheet button.row', { hasText: 'Modifier les métadonnées' }).click();
    await page.waitForTimeout(1500);
  },
  async itemIdentify(page) {
    await SCENES.itemMenu(page);
    await page.locator('.sheet button.row', { hasText: 'Modifier les images' }).click();
    await page.waitForTimeout(1500);
  },
  // A title downloaded from its menu, then the Downloads tab.
  async downloads(page) {
    await SCENES.itemMenu(page);
    await page.locator('.sheet button.row', { hasText: 'Télécharger' }).click();
    await page.waitForTimeout(4000);
    await page.locator('nav button').nth(2).click();
    await page.waitForTimeout(1200);
  },
  // Settings: from the account menu (the tab bar has no Settings tab).
  async settings(page) {
    await page.locator('[data-screen-top] button.me, button.me.floating').first().click();
    await page.locator('.menu .item').first().click();
    await page.waitForTimeout(500);
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  fs.mkdirSync(OUT, { recursive: true });
  const mockPort = await freePort();
  const mock = await startMock(mockPort);
  const vite = await createServer({ configFile: path.join(APP, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await vite.listen();
  const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  const browser = await webkit.launch();
  const errors = [];
  try {
    const context = await browser.newContext({
      // SHOTS_LANDSCAPE=1: the phone on its side (the player scenes).
      viewport: process.env.SHOTS_LANDSCAPE === '1' ? { width: 932, height: 430 } : { width: 430, height: 873 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: process.env.SHOTS_DARK === '0' ? 'light' : 'dark',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(({ top, bottom, left, right }) => {
      const set = () => {
        document.documentElement.style.setProperty('--safe-top', `${top}px`);
        document.documentElement.style.setProperty('--safe-bottom', `${bottom}px`);
        document.documentElement.style.setProperty('--safe-left', `${left}px`);
        document.documentElement.style.setProperty('--safe-right', `${right}px`);
      };
      if (document.documentElement) set();
      else document.addEventListener('DOMContentLoaded', set);
    }, SAFE);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    // Sign in through the real flow.
    await page.goto(appUrl);
    if (!wanted.length || wanted.includes('login')) await page.screenshot({ path: path.join(OUT, 'login.png') });
    await page.getByRole('textbox').first().fill(`http://127.0.0.1:${mockPort}`);
    await page.keyboard.press('Enter');
    await page.getByText('Wika', { exact: true }).click();
    await page.locator('input[type=password]').fill('wicaby');
    await page.keyboard.press('Enter');
    await page.locator('nav').waitFor();
    await page.waitForTimeout(1500);
    const state = await context.storageState();

    for (const [name, run] of Object.entries(SCENES)) {
      if (wanted.length && !wanted.includes(name)) continue;
      const p = await context.newPage();
      await context.addCookies(state.cookies);
      p.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
      await p.goto(appUrl);
      await p.locator('nav').waitFor();
      await p.waitForTimeout(1200);
      await run(p);
      if (process.env.SHOTS_EVAL) console.log(name, JSON.stringify(await p.evaluate(process.env.SHOTS_EVAL)));
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log(`shot ${name}`);
      await p.close();
    }
  } finally {
    await browser.close();
    await vite.close();
    mock.kill();
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`shots in ${OUT}`);
}

await main();
