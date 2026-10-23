// Reorder check: in the Libraries tab (mock server, demo data), a finger held on the first library lifts it, a drag
// to the bottom moves it there, and letting go keeps that order (saved, and no library page opened); a quick swipe
// over the list only scrolls. Touches go through Chromium's DevTools protocol, as a phone's would.
// Run: node apps/mobile-web/scripts/reorder-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const APP = path.join(ROOT, 'apps', 'mobile-web');
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const mock = spawn(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(port)], { env: { ...process.env, MOCK_DATASET: 'demo' }, stdio: 'ignore', windowsHide: true });
const vite = await createServer({ configFile: path.join(APP, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await vite.listen();
const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;
const executablePath = [process.env.PLAYER_BROWSER, 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true });
  await new Promise((r) => setTimeout(r, 800));
  await page.goto(appUrl);
  await page.getByRole('textbox').first().fill(`http://127.0.0.1:${port}`);
  await page.keyboard.press('Enter');
  await page.getByText('Wika', { exact: true }).click();
  await page.locator('input[type=password]').fill('wicaby');
  await page.keyboard.press('Enter');
  await page.locator('nav').waitFor();
  await page.locator('nav button').nth(1).click();
  await page.waitForTimeout(1200);
  const names = () => page.locator('[data-screen-top] .lib .name').allTextContents();
  const before = await names();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const box = async (i) => (await page.locator('[data-screen-top] .lib').nth(i).boundingBox());

  // A quick swipe: a scroll, nothing lifted or moved.
  const a = await box(0);
  await touch('touchStart', a.x + a.width / 2, a.y + a.height / 2);
  for (let i = 1; i <= 6; i++) await touch('touchMove', a.x + a.width / 2, a.y + a.height / 2 - i * 20);
  await touch('touchEnd');
  await page.waitForTimeout(400);
  check(JSON.stringify(await names()) === JSON.stringify(before), `swipe keeps the order (${before.length} libraries)`);

  if (process.env.DEBUG) {
    page.on('console', (m) => console.log('  [console]', m.text()));
    await page.evaluate(() => ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((t) => document.addEventListener(t, (e) => console.log(t, e.target.tagName, !!e.target.closest?.('.lib'), e.target.closest?.('.lib')?.parentElement?.className), true)));
  }
  await page.evaluate(() => document.querySelectorAll('[data-scroll]').forEach((el) => el.scrollTo(0, 0)));
  await page.waitForTimeout(300);
  // Hold, then drag the first library past the last one.
  const first = await box(0);
  const last = await box(before.length - 1);
  const x = first.x + first.width / 2;
  let y = first.y + first.height / 2;
  if (process.env.DEBUG) console.log('  [debug] hold at', x, y, await page.evaluate(([px, py]) => { const e = document.elementFromPoint(px, py); return e ? e.tagName + '.' + e.className : 'none'; }, [x, y]));
  await touch('touchStart', x, y);
  await page.waitForTimeout(600);
  const liftedOk = await page.locator('[data-screen-top] .lib.lifted').count();
  const goal = last.y + last.height * 0.8;
  while (y < goal) {
    y = Math.min(goal, y + 12);
    await touch('touchMove', x, y);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(300);
  await touch('touchEnd');
  await page.waitForTimeout(800);
  const after = await names();
  check(liftedOk === 1, 'a long press lifts the library');
  check(after[after.length - 1] === before[0] && after.length === before.length, `dropped last: ${after.join(' · ')}`);
  check((await page.locator('[data-screen-top] .lib').count()) === before.length, 'no library page opened by the drop');
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => /libraryOrder/.test(k)).map((k) => localStorage.getItem(k)).join(''));
  check(saved.includes('"'), 'order saved on the phone');
  await page.reload();
  await page.locator('nav').waitFor();
  await page.locator('nav button').nth(1).click();
  await page.waitForTimeout(1200);
  check(JSON.stringify(await names()) === JSON.stringify(after), 'order kept after a restart');
} finally {
  await browser.close();
  await vite.close();
  mock.kill();
}
console.log(failed ? `reorder-check: ${failed} failed` : 'reorder-check: ok');
process.exit(failed ? 1 : 0);
