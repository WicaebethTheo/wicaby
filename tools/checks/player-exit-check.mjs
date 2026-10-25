// Source checks for the player exit transition (the frame-by-frame proof is player-exit-cdp.mjs, which needs
// mpv and the screen). Usage: node tools/checks/player-exit-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (p) => fs.readFileSync(new URL(`../../apps/desktop/src/${p}`, import.meta.url), 'utf8');
// Body of the first method declared as `<sig>(`, up to the next line that closes a class member.
const body = (text, sig) => {
  const at = text.indexOf(`${sig}(`);
  assert.ok(at >= 0, `${sig} not found`);
  return text.slice(at, text.indexOf('\n  }\n', at));
};

const service = src('main/playback/playback-service.ts');
// Only a real exit animates: stop() is the one caller of leave(), never advance() (Up Next, auto-advance).
assert.equal(service.match(/this\.leave\(/g)?.length, 1, 'leave() has a single caller');
assert.match(body(service, '  async stop'), /animate && this\.state\.active\) await \(this\.exiting = this\.leave\(player\)/, 'stop() plays the exit transition');
assert.doesNotMatch(body(service, '  private async advance').replace('if (!this.queue.hasNext) return this.stop();', ''), /stop\(|leave\(/, 'advance() to the next item never runs the exit transition');
assert.match(body(service, '  async shutdown'), /this\.stop\(false\)/, 'quitting does not animate');
assert.match(service, /player\.on\('closed', \(\) => \{[\s\S]*?this\.stop\(false\)/, 'a closed player window does not animate');
assert.match(body(service, '  private async leave'), /player\.pause\(\);/, 'paused at once when leaving');

const windows = src('main/windows/window-manager.ts');
// The main window must not be shown on top of the transition, nor steal the focus back afterwards.
assert.match(body(windows, '  destroyPlaybackWindows'), /!this\.main\.isVisible\(\)\) \{\s*this\.mainLikePlayback\(pw\);\s*this\.main\.show\(\);/, 'destroyPlaybackWindows shows main only when hidden');
assert.match(body(windows, '  async showMainUnder'), /setAlwaysOnTop\(true\);\s*main\.showInactive\(\);/, 'the OSD floats above main before main shows');

for (const p of ['main/playback/mpv-player.ts', 'main/playback/html-player.ts']) assert.match(src(p), /async leave\(reduced: boolean/, `${p} implements leave()`);

// The built-in player covers the page it came from, which stays mounted under it (no reload on the way back).
const app = src('renderer/App.svelte');
assert.doesNotMatch(app, /\{:else if route\.name === 'player'\}/, 'the player no longer replaces the page');
// The full-screen music player (music-spec MU-04) covers the page the same way.
assert.match(app, /inert=\{playing( \|\| nowPlaying)?\}/, 'the page under the player is inert');
assert.match(app, /\{#if !isOsd && playing[^}]*\}<Player \/>/, 'the player renders over the page');
// A disabled Play button drops the focus the item page must get back.
assert.doesNotMatch(src('renderer/routes/Item.svelte'), /onclick=\{\(\) => play\((true|false)\)\} disabled=/, 'Play buttons keep the focus');

const osd = src('renderer/routes/OsdWindow.svelte');
assert.match(osd, /class="veil" class:on=\{veil\}/, 'the OSD has its veil');
assert.match(osd, /__wicabyVeil/, 'main can wait for the opening veil');

console.log('player exit checks passed');
