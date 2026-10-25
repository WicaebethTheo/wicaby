// Playback windows look like the main window (window-geometry.ts): they open in its place and state, and the main
// window comes back in the place and state the player was left in. Pure rules plus source guards for the wiring
// (the windows themselves need Electron and a screen: player-exit-cdp.mjs).
// Run: node tools/checks/playback-window-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { centred, mainAfterPlayback, near, playbackRect } from '../../apps/desktop/src/main/windows/window-geometry.ts';

const R = (x, y, width, height) => ({ x, y, width, height });
const left = R(0, 0, 1920, 1032); // work area of the left monitor (taskbar at the bottom)
const right = R(1920, 0, 2560, 1392);
const plain = R(200, 100, 1280, 800);
const snapped = R(0, 0, 960, 1032);

assert.ok(near(R(0, 0, 100, 100), R(1, -1, 101, 99)), '1 px of DIP rounding is the same rectangle');
assert.ok(!near(R(0, 0, 100, 100), R(2, 0, 100, 100)));
assert.deepEqual(centred(R(5000, 5000, 3000, 800), left), R(0, 116, 1920, 800), 'shrunk to fit and centred');

// Opening: the main window's place.
const st = (bounds, extra = {}) => ({ bounds, normal: plain, maximized: false, minimized: false, fullscreen: false, ...extra });
assert.deepEqual(playbackRect(st(plain), left), plain, 'a plain window: its rectangle');
assert.deepEqual(playbackRect(st(snapped), left), snapped, 'a snapped half: its rectangle');
assert.deepEqual(playbackRect(st(R(-8, -8, 1936, 1048), { maximized: true }), left), left, 'maximized: the work area, not the overhanging bounds');
assert.deepEqual(playbackRect(st(R(-32000, -32000, 160, 28), { minimized: true }), left), plain, 'minimized: its restore rectangle');
assert.deepEqual(playbackRect(st(R(0, 0, 1920, 1080), { fullscreen: true }), left), plain, 'full screen (Reader): its restore rectangle');

// Back: the player's place.
const main = (bounds, maximized = false, work = left) => ({ bounds, normal: maximized ? plain : bounds, maximized, work });
const after = (m, player, work = left) => mainAfterPlayback(m, player, near(player, work), work);
assert.deepEqual(after(main(snapped), snapped), { maximize: false, bounds: null }, 'untouched snapped half: no setBounds (keeps the snap)');
assert.deepEqual(after(main(plain), R(300, 150, 1000, 700)), { maximize: false, bounds: R(300, 150, 1000, 700) }, 'moved and resized: carried over');
assert.deepEqual(after(main(left, true), left), { maximize: true, bounds: null }, 'maximized both ways: nothing to do');
assert.deepEqual(after(main(left, true), plain), { maximize: false, bounds: plain }, 'player restored to a plain window: main unmaximized there');
assert.deepEqual(after(main(plain), left), { maximize: true, bounds: null }, 'player maximized on the same monitor: main maximized');
assert.deepEqual(after(main(plain), right, right), { maximize: true, bounds: centred(plain, right) }, 'maximized on another monitor: restore rectangle moves there first');
// A round trip without touching anything changes nothing.
for (const m of [main(plain), main(snapped), main(left, true)]) {
  const open = playbackRect({ bounds: m.bounds, normal: m.normal, maximized: m.maximized, minimized: false, fullscreen: false }, left);
  const step = after(m, open);
  assert.equal(step.bounds, null, `round trip from ${JSON.stringify(m.bounds)}: no move`);
  assert.equal(step.maximize, m.maximized, 'round trip: same maximized state');
}

// Wiring in window-manager.ts.
const wm = fs.readFileSync(new URL('../../apps/desktop/src/main/windows/window-manager.ts', import.meta.url), 'utf8');
const body = (sig) => {
  const at = wm.indexOf(`${sig}(`);
  assert.ok(at >= 0, `${sig} not found`);
  return wm.slice(at, wm.indexOf('\n  }\n', at));
};
assert.match(body('  createPlaybackWindows'), /const ref = m\s*\? playbackRect\(/, 'the pair opens in the main window\'s place');
assert.match(body('  createPlaybackWindows'), /if \(fullscreen\) this\.setPlaybackFullscreen\(true\);/, 'the pair is full screen only when asked');
const single = body('  createPlaybackWindow');
assert.match(single, /const maximized = m \? this\.wasMaximized\(m\)/, 'the Wayland window takes the main window\'s maximized state');
assert.match(body('  private mainLikePlayback'), /filled = this\.pipBounds \? this\.pipMaximized : pw\.osd\.isMaximized\(\)/, 'Wayland PiP keeps the maximized state');
assert.match(single, /osd\.show\(\);[\s\S]*if \(maximized\) osd\.maximize\(\);\s*if \(fullscreen\) osd\.setFullScreen\(true\);/, 'maximize and full screen after the first map');
assert.match(body('  async showMainUnder'), /this\.mainLikePlayback\(pw\);[\s\S]*main\.showInactive\(\);\s*if \(pw\) this\.mainLikePlayback\(pw\);/, 'the main window takes the player\'s state before and after it shows');
assert.match(body('  private mainLikePlayback'), /this\.pipBounds \?\? this\.savedPlaybackBounds \?\? pw\.video\.getBounds\(\)/, 'the windowed rectangle under PiP or full screen');

console.log('playback window checks passed');
