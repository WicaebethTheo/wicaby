// Self-check for the desktop comfort fixes (plezy-triage WP3/WP12, infuse-ideas sprint 1):
//  - B05 the power blocker follows pause and play (mpv and <video> share the 'time' path);
//  - B04 language defaults follow the server, old untouched defaults are migrated once, films keep a track pick;
//  - B26 the subtitle delay is not remembered per series unless chosen;
//  - B21 refresh-rate choice: 23.976 / 59.94 modes over 24 / 60 (Linux pickRate, and the Windows script
//    run through PowerShell with fake mode lists when on Windows);
//  - B27 Enter skips over a control focused by a mouse click; hold for 2x (not live, not bitstream).
// mpv arguments (deinterlace, media-controls) are in mpv-args-check.mjs.
// Run: node tools/checks/desktop-comfort-check.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { pickAudio, pickSubtitle, selectTracks, rememberChoice } from '../../apps/desktop/src/shared/track-selection.ts';
import { pickRate } from '../../apps/desktop/src/main/features/display-mode-linux.ts';

const desktop = path.join(import.meta.dirname, '..', '..', 'apps', 'desktop');
const read = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-comfort-'));

// ---- B05 power blocker ----
const service = read('src/main/playback/playback-service.ts');
const attach = service.slice(service.indexOf('private attach('), service.indexOf('private watchMinimize('));
assert.match(attach, /if \(pausedChanged\) \{\s*this\.pausePower\(t\.paused\);/, 'every pause/play change (mpv and html) goes through pausePower');
const pausePower = service.slice(service.indexOf('private pausePower('), service.indexOf('private releasePower('));
assert.match(pausePower, /if \(!paused\) this\.blockPower\(this\.powerVideo\);/, 'play re-arms the blocker with the last kind');
assert.match(pausePower, /else if \(this\.current\?\.live\) this\.startPower\('prevent-app-suspension'\);/, 'a live pause keeps the app awake, not the display');
assert.match(pausePower, /else this\.releasePower\(\);/, 'a VOD pause lets the display sleep');
assert.match(service, /private blockPower\(video: boolean\): void \{\s*this\.powerVideo = video;/, 'blockPower records its kind');

// ---- B04 settings: defaults and the one-time migration ----
const settingsOut = path.join(tmp, 'settings.mjs');
await build({
  entryPoints: [path.join(desktop, 'src/main/core/settings.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: settingsOut,
  logLevel: 'error',
  plugins: [{ name: 'electron-stub', setup: (b) => {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(tmp)}, getLocale: () => 'fr', isReady: () => false, on() {} };` }));
  } }],
});
const { SettingsService, defaultSettings } = await import(pathToFileURL(settingsOut).href);
const d = defaultSettings();
assert.equal(d.playback.preferredAudioLanguage, '', 'default audio language: the server preference');
assert.equal(d.playback.preferredSubtitleLanguage, '', 'default subtitle language: the server preference');
assert.equal(d.playback.rememberScopes.subtitleDelay, 'off', 'B26: subtitle delay not remembered by default');
assert.equal(d.defaultsVersion, 3);
assert.equal(d.playback.startFullscreen, false, 'videos open in the window by default');
assert.equal(d.playback.smoothMotion, false, 'Smooth Playback off by default');

const OLD_SCOPES = { speed: 'global', audioDelay: 'title', subtitleDelay: 'title', aspect: 'title' };
let n = 0;
const load = (doc) => {
  const file = path.join(tmp, `settings-${n++}.json`);
  if (doc) fs.writeFileSync(file, JSON.stringify(doc));
  const svc = new SettingsService(file);
  svc.flush();
  return { v: svc.value, saved: JSON.parse(fs.readFileSync(file, 'utf8')) };
};
// A fresh install.
assert.equal(load(null).v.playback.preferredAudioLanguage, '');
// An old file with the untouched French defaults: migrated, and the marker saved.
let r = load({ playback: { preferredAudioLanguage: 'fre', preferredSubtitleLanguage: 'fre', subtitleMode: 'foreign', rememberScopes: OLD_SCOPES } });
assert.equal(r.v.playback.preferredAudioLanguage, '');
assert.equal(r.v.playback.preferredSubtitleLanguage, '');
assert.equal(r.v.playback.subtitleMode, 'foreign');
assert.equal(r.v.playback.rememberScopes.subtitleDelay, 'off');
assert.equal(r.saved.defaultsVersion, 3);
// Values the user picked stay.
r = load({ playback: { preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'fre', rememberScopes: { ...OLD_SCOPES, speed: 'title' } } });
assert.equal(r.v.playback.preferredAudioLanguage, 'eng');
assert.equal(r.v.playback.preferredSubtitleLanguage, 'fre');
assert.equal(r.v.playback.rememberScopes.subtitleDelay, 'title', 'a touched scope block is kept');
// Once migrated, French picked again later is the user's.
r = load({ defaultsVersion: 1, playback: { preferredAudioLanguage: 'fre', preferredSubtitleLanguage: 'fre', rememberScopes: OLD_SCOPES } });
assert.equal(r.v.playback.preferredAudioLanguage, 'fre');
assert.equal(r.v.playback.rememberScopes.subtitleDelay, 'title');
// Version 2: the 0.10.7 files hold Smooth Playback on (its default then): turned off once, then the user's.
r = load({ defaultsVersion: 1, playback: { smoothMotion: true } });
assert.equal(r.v.playback.smoothMotion, false);
r = load({ defaultsVersion: 2, playback: { smoothMotion: true } });
assert.equal(r.v.playback.smoothMotion, true);
// Version 3: Start in Full Screen (on by default up to 0.14.0) is turned off once, then it is the user's.
r = load({ defaultsVersion: 2, playback: { startFullscreen: true } });
assert.equal(r.v.playback.startFullscreen, false);
assert.equal(r.saved.defaultsVersion, 3, 'marker saved: never runs again');
assert.equal(load({ defaultsVersion: 3, playback: { startFullscreen: true } }).v.playback.startFullscreen, true);
assert.equal(load({ playback: { startFullscreen: 'yes' } }).v.playback.startFullscreen, false, 'non-boolean is off');
{
  // Turned back on after the migration: kept across a restart, and importing an older file does not undo it later.
  const f = path.join(tmp, 'fs-again.json');
  fs.writeFileSync(f, JSON.stringify({ defaultsVersion: 2, playback: { startFullscreen: true } }));
  let svc = new SettingsService(f);
  assert.equal(svc.value.playback.startFullscreen, false);
  svc.update({ playback: { startFullscreen: true } });
  svc.flush();
  assert.equal(new SettingsService(f).value.playback.startFullscreen, true, 'migration never re-runs');
  svc = new SettingsService(f);
  svc.replace({ defaultsVersion: 1, playback: { startFullscreen: true } });
  svc.flush();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).defaultsVersion, 3, 'an import keeps the machine marker');
  assert.equal(new SettingsService(f).value.playback.startFullscreen, true, 'an imported choice stays after a restart');
}
// Themes: builds before the theme list stored Graphite as 'dark'; a known id stays, an unknown one is Graphite.
assert.equal(load(null).v.ui.theme, 'graphite');
assert.equal(load({ ui: { theme: 'dark' } }).v.ui.theme, 'graphite');
assert.equal(load({ ui: { theme: 'oled' } }).v.ui.theme, 'oled');
assert.equal(load({ ui: { theme: 'light' } }).v.ui.theme, 'light');
assert.equal(load({ ui: { theme: 'bogus' } }).v.ui.theme, 'graphite');

// ---- B04 track selection with the server preference ----
const a = (Index, Language, extra = {}) => ({ Index, Type: 'Audio', Language, ...extra });
const s = (Index, Language, extra = {}) => ({ Index, Type: 'Subtitle', Language, ...extra });
const film = [{ Index: 0, Type: 'Video' }, a(1, 'fre', { IsDefault: true }), a(2, 'eng'), s(3, 'fre'), s(4, 'eng')];
const server = { audio: 2, subtitle: 4 };
const empty = (mode) => ({ audioLanguage: '', subtitleLanguage: '', mode, forced: true });
assert.equal(pickAudio(film, server, empty('foreign')), 2, 'no language set: the server user default audio');
assert.equal(pickSubtitle(film, 2, server, empty('foreign')), 4, 'no language set: the server user default subtitle');
assert.equal(pickSubtitle(film, 2, {}, empty('foreign')), null, 'no server default: no subtitle');
assert.equal(pickSubtitle(film, 2, server, empty('always')), 4);
// A film's own pick (keyed by its Id) wins on resume, subtitles off included.
let doc = rememberChoice({}, 'film-id', 'audio', film[1], 1, film);
doc = rememberChoice(doc, 'film-id', 'subtitle', null, 2, film);
assert.deepEqual(selectTracks(film, server, empty('foreign'), doc['film-id']), { audio: 1, subtitle: null, applied: true });
assert.match(service, /this\.memory\.tracksFor\(item\.SeriesId \?\? item\.Id\)/, 'films read their own track memory');
assert.match(service, /this\.memory\.rememberTrack\(c, c\.item\.SeriesId \?\? c\.item\.Id, kind, index\)/, 'films record their own track memory');

// ---- B21 refresh-rate choice ----
assert.equal(pickRate(24, [24, 23.976, 60], 23.976), 23.976, '24 Hz gives way to 23.976 for 23.976 fps');
assert.equal(pickRate(60, [60, 24, 23.98], 23.976), 23.98, 'xrandr rounding still matches');
assert.equal(pickRate(60, [60, 24], 23.976), 24, 'without 23.976, 24 Hz still beats 3:2 at 60 Hz');
assert.equal(pickRate(60, [60, 59.94], 29.97), 59.94, '59.94 for 29.97 fps');
assert.equal(pickRate(60, [60, 30], 29.97), null, 'near already: no switch to a 30 Hz desktop');
assert.equal(pickRate(23.976, [60, 24, 23.976], 23.976), null, 'exact already');
// The Windows script: the same rule on integer dmDisplayFrequency (23 = 23.976 Hz...). Its decision block
// runs in PowerShell over fake mode lists; nothing touches the display.
if (process.platform === 'win32') {
  const src = read('src/main/features/display-mode.ts');
  const block = src.slice(src.indexOf('  $rates = $rates | Sort-Object -Unique'), src.indexOf('  $target = $best'));
  assert.ok(block.includes('function Eff') && block.includes('$tol'), 'decision block found');
  const cases = [
    [60, [60, 24, 23], 23.976, 'set 23'],
    [24, [60, 24, 23], 23.976, 'set 23'],
    [60, [60, 24], 23.976, 'set 24'],
    [60, [60, 59], 29.97, 'set 59'],
    [60, [60, 30], 29.97, 'keep 60'],
    [60, [60, 50], 25, 'set 50'],
    [60, [60, 24], 30, 'keep 60'],
    [59, [60, 59, 23], 59.94, 'keep 59'],
  ];
  const fn = `function Decide([int]$curHz, [int[]]$rates, [double]$Fps) { $cur = @{ dmDisplayFrequency = $curHz }\n${block.replace(/; exit 0 \}/g, '; return }').replace(/Write-Output "keep/g, 'return "keep')}\n  return "set $best" }`;
  const script = `${fn}\n${cases.map(([c, rates, fps]) => `Decide ${c} @(${rates.join(',')}) ${fps}`).join('\n')}`;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stderr);
  const got = ps.stdout.trim().split(/\r?\n/).map((l) => l.trim());
  cases.forEach(([c, rates, fps, want], i) => assert.equal(got[i], want, `windows ${c} Hz [${rates}] for ${fps} fps`));
}

// ---- B27 Enter, hold for 2x ----
const osd = read('src/renderer/components/Osd.svelte');
assert.match(osd, /case 'skipSegment':[\s\S]{0,400}target\?\.tagName === 'BUTTON' && \(panel \|\| target\.closest\('\.skip-pill, \.nextup'\)\)/, 'Enter skips unless the pill, Up Next or a panel has focus');
const startHold = osd.slice(osd.indexOf('function startHold('), osd.indexOf('function endHold('));
assert.match(startHold, /s\.live/, 'no hold for live');
assert.match(startHold, /s\.stats\.audioBitstream/, 'no hold with bitstreamed audio');
assert.match(startHold, /cmd\(\{ type: 'rate', value: HOLD_RATE, hold: true \}\)/);
assert.match(osd, /id === 'seekForward' && e\.repeat && \(holdBy === 'key' \|\| startHold\('key'\)\)/, 'a held Seek forward key holds 2x');
assert.match(osd, /onpointerdown=\{onSurfaceDown\} onpointerup=\{endHold\} onpointerleave=\{endHold\}/, 'mouse hold on the picture');
assert.match(service, /!this\.current\.live && !cmd\.hold\) this\.remember\('speed'/, 'a hold never becomes the remembered speed');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('desktop-comfort-check: OK');
