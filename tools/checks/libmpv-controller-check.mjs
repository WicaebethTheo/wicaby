// Self-check for the in-process libmpv transport (native Wayland, texture mode), against a fake NativePlayer, so
// it needs neither the addon nor a display:
//  - MpvPlayer's command line becomes option/value pairs (embedding options dropped, vo=libmpv, silent ao);
//  - LibmpvController keeps MpvController's surface and events (property, event, ao-failed/vo-failed from the
//    log, exit, hung after 10 s without a ping answer, quit);
//  - VideoSurface imports every frame on its own, one per slot at a time, and hands the slot back only from
//    allReferencesReleased (main and renderer both released), on every path.
// The addon itself is checked by its own Linux check. Run: node tools/checks/libmpv-controller-check.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = path.join(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-libmpv-'));
const entry = path.join(tmp, 'entry.ts');
const pb = (f) => JSON.stringify(path.join(desktop, 'src/main/playback', f));
fs.writeFileSync(
  entry,
  [
    `export { LibmpvController, libmpvOptions, libmpvPlan, mpvConfArgs, inProcessAo, inProcessAudioDevice } from ${pb('libmpv-controller.ts')};`,
    `export { VideoSurface } from ${pb('video-surface.ts')};`,
    `export { mpvOutputArgs } from ${JSON.stringify(path.join(desktop, 'src/shared/mpv-args.ts'))};`,
  ].join('\n'),
);
const out = path.join(tmp, 'bundle.mjs');
// electron: the fake below, read at call time through globalThis.
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  plugins: [{ name: 'electron-stub', setup: (b) => {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `const f = () => globalThis.__electron;
export const app = { isReady: () => false, getLocale: () => 'en', isPackaged: true, getPath: () => ${JSON.stringify(tmp)}, on() {} };
export const screen = { on: (...a) => f().screen.on(...a), off: (...a) => f().screen.off(...a), getDisplayMatching: (b) => f().screen.getDisplayMatching(b) };
export const sharedTexture = { importSharedTexture: (o) => f().sharedTexture.importSharedTexture(o), sendSharedTexture: (...a) => f().sharedTexture.sendSharedTexture(...a) };`,
    }));
  } }],
});
const { LibmpvController, libmpvOptions, libmpvPlan, mpvConfArgs, inProcessAo, inProcessAudioDevice, VideoSurface, mpvOutputArgs } = await import(pathToFileURL(out).href);

// ---- option mapping: the arguments MpvPlayer.create passes (embedded control list, base list, fixed list) ----
const linuxOut = mpvOutputArgs({ hwdec: 'vaapi', useMpvConfig: false, audioExclusive: false, smoothMotion: true }, 'linux', '0.41.0', true);
const args = [
  '--no-config',
  '--hr-seek=yes',
  '--cache=yes',
  '--demuxer-max-bytes=512MiB',
  '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
  '--sub-fonts-dir=/tmp/fonts',
  ...linuxOut,
  '--volume-max=100',
  '--background-color=#000000',
  '--audio-device=auto',
  '--wid=12345',
  '--osc=no',
  '--input-default-bindings=no',
  '--idle=yes',
  '--force-window=yes',
  '--terminal=yes',
  '--msg-level=all=warn',
  '--input-ipc-server=/tmp/x.sock',
];
const opts = libmpvOptions(args, false);
const optMap = new Map(opts);
for (const gone of ['wid', 'input-ipc-server', 'gpu-context', 'gpu-api', 'force-window']) assert.ok(!optMap.has(gone), `${gone} is dropped`);
assert.equal(opts.filter(([k]) => k === 'vo').length, 1, 'one vo');
assert.equal(optMap.get('vo'), 'libmpv', 'vo forced to libmpv (gpu-next dropped)');
assert.equal(opts.filter(([k]) => k === 'terminal').length, 1, 'one terminal');
assert.equal(optMap.get('terminal'), 'no', 'terminal=no: logs come through mpv_request_log_messages');
assert.equal(optMap.get('config'), 'no', '--no-config becomes config=no');
assert.equal(optMap.get('stream-lavf-o'), 'reconnect=1,reconnect_streamed=1,reconnect_delay_max=5', 'split at the first =');
assert.equal(optMap.get('msg-level'), 'all=warn');
assert.equal(optMap.get('background-color'), '#000000');
assert.equal(optMap.get('hwdec'), 'vaapi,auto-safe', 'hwdec kept');
assert.equal(optMap.get('video-sync'), 'display-resample', 'video-sync kept');
assert.equal(optMap.get('ao'), 'pulse,alsa', 'not silent: the configured outputs, pipewire left out in process (rtkit RLIMIT_RTTIME kill)');
assert.equal(inProcessAo('pipewire'), 'pulse,alsa', 'pipewire only: pulse then alsa');
assert.equal(inProcessAo('alsa,pipewire'), 'alsa');
assert.equal(inProcessAudioDevice('pipewire/alsa_output.usb-dac'), 'pulse/alsa_output.usb-dac');
assert.equal(inProcessAudioDevice('auto'), 'auto');
assert.equal(new Map(libmpvOptions(['--audio-device=pipewire/hdmi'], false)).get('audio-device'), 'pulse/hdmi');
assert.deepEqual(libmpvOptions(['--fullscreen', '--no-audio-display', 'stray', '--'], false).slice(0, 2), [['fullscreen', 'yes'], ['audio-display', 'no']], 'bare flags and --no-');
const silent = libmpvOptions(args, true);
assert.deepEqual(silent.at(-1), ['ao', 'null'], 'WICABY_TEST_SILENT: ao=null after every other ao');
assert.equal(optMap.get('video-timing-offset'), '0', 'video-timing-offset=0: frames are signalled at their display time');

// A user mpv.conf ("Utiliser mpv.conf"): config stays no, the file goes through the allow-list at --include's place,
// so nothing in it can replace the forced or fixed options (vo, scripts, IPC, osc...).
{
  const conf = [
    '# comment',
    'vo=gpu-next',
    'load-scripts=yes',
    'scripts=/home/u/evil.lua',
    'input-ipc-server=/tmp/user.sock',
    'ytdl=yes',
    'osc=yes',
    'include=/etc/other.conf',
    'profile=gpu-hq',
    '--deband',
    'sub-color = "#FFFF00"  # yellow',
    "sub-font='Noto Sans'",
    'sub-font-size=%2%44',
    'volume-max=130 # louder',
    'glsl-shaders-append=~~/shaders/a.glsl',
    '[gpu-hq]',
    'scale=ewa_lanczossharp',
    '[default]',
    'saturation=5',
  ].join('\n');
  const mpvArgs = ['--config=yes', '--config-dir=/cfg', '--volume-max=100', '--include=/cfg/mpv.conf', '--osc=no', '--load-scripts=no', '--ytdl=no'];
  const read = (f) => (assert.equal(f, '/cfg/mpv.conf'), conf);
  const plan = libmpvPlan(mpvArgs, false, read);
  const names = plan.options.map(([k]) => k);
  const last = (k) => plan.options.findLast(([n]) => n === k)?.[1];
  assert.equal(last('config'), 'no', '--config=yes never reaches libmpv: mpv_initialize would load mpv.conf over everything');
  assert.equal(last('config-dir'), '/cfg', 'config-dir kept for ~~ paths');
  for (const k of ['scripts', 'input-ipc-server', 'ytdl', 'include', 'profile', 'scale']) assert.ok(!plan.options.some(([n, v]) => n === k && v !== 'no'), `${k} from mpv.conf refused`);
  assert.equal(plan.options.filter(([n]) => n === 'vo').length, 1, 'mpv.conf vo refused');
  assert.equal(last('vo'), 'libmpv');
  assert.deepEqual(plan.options.filter(([n]) => n === 'load-scripts' || n === 'osc'), [['osc', 'no'], ['load-scripts', 'no']], 'only the fixed osc/load-scripts');
  assert.equal(last('volume-max'), '130', 'mpv.conf after Wicaby defaults wins over them');
  assert.ok(names.indexOf('volume-max') < names.lastIndexOf('saturation') && names.lastIndexOf('saturation') < names.indexOf('osc'), 'mpv.conf in place, before the fixed options');
  assert.equal(last('sub-color'), '#FFFF00', 'quoted value, trailing comment');
  assert.equal(last('sub-font'), 'Noto Sans', 'single quotes');
  assert.equal(last('sub-font-size'), '44', '%n% value');
  assert.equal(last('deband'), 'yes', 'bare flag with --');
  assert.equal(last('saturation'), '5', '[default] is the top level again');
  assert.deepEqual(plan.listOps, [['glsl-shaders', 'append', '~~/shaders/a.glsl']], 'list action from mpv.conf after initialize');
  const c = mpvConfArgs(conf);
  assert.deepEqual(c.profiles, ['gpu-hq']);
  assert.ok(c.rejected.includes('vo=gpu-next') && c.rejected.includes('scripts=/home/u/evil.lua') && c.rejected.includes('input-ipc-server=/tmp/user.sock'), 'refused lines reported');
  assert.deepEqual(libmpvPlan(['--include=/missing.conf'], false, () => { throw new Error('ENOENT'); }).options.at(-1), ['video-timing-offset', '0'], 'an unreadable mpv.conf is skipped');
}

// List options with an action suffix: mpv_set_option_string only knows the bare name, so change-list after
// mpv_initialize; a later plain set of the list drops the actions before it, as the CLI does.
{
  const plan = libmpvPlan(['--glsl-shaders-append=~~/a.glsl', '--sub-file-paths-append=subs', '--glsl-shaders=~~/b.glsl', '--glsl-shaders-pre=~~/c.glsl', '--vf-clr'], false);
  assert.ok(!plan.options.some(([n]) => /-(append|pre|clr)$/.test(n)), 'no suffixed name reaches setOption');
  assert.deepEqual(plan.options.filter(([n]) => n === 'glsl-shaders'), [['glsl-shaders', '~~/b.glsl']]);
  assert.deepEqual(plan.listOps, [['sub-file-paths', 'append', 'subs'], ['glsl-shaders', 'pre', '~~/c.glsl'], ['vf', 'clr', '']]);
}

// ---- a fake addon ----
function fakeLib() {
  const calls = [];
  const lib = {
    calls,
    emit: null,
    renderNode: undefined,
    pidAnswers: true,
    quitAnswers: true,
    failOption: null,
    probe: () => ({ ok: true, apiVersion: 0x20005 }),
    create(onEvent, renderNode) {
      lib.emit = onEvent;
      lib.renderNode = renderNode;
      return {
        setOption(name, value) {
          if (name === lib.failOption) throw new Error('option not found');
          calls.push(['setOption', name, value]);
        },
        initialize: (w, h) => calls.push(['initialize', w, h]),
        command(a) {
          calls.push(['command', a]);
          if (a[0] === 'quit' && !lib.quitAnswers) return new Promise(() => {});
          if (a[0] === 'fail') return Promise.reject(new Error('invalid parameter'));
          return Promise.resolve(null);
        },
        setProperty: (n, v) => (calls.push(['setProperty', n, v]), Promise.resolve()),
        getProperty(n) {
          calls.push(['getProperty', n]);
          if (n === 'pid') return lib.pidAnswers ? Promise.resolve(42) : new Promise(() => {});
          if (n === lib.stuck) return new Promise(() => {});
          return Promise.resolve(n === 'volume' ? 80 : n === 'mpv-version' ? 'mpv 0.41.0' : null);
        },
        observe: (n) => calls.push(['observe', n]),
        resize: (w, h) => calls.push(['resize', w, h]),
        releaseFrame: (g, s) => calls.push(['releaseFrame', g, s]),
        destroy: () => (calls.push(['destroy']), Promise.resolve()),
      };
    },
  };
  return lib;
}
const record = (ctl, names) => {
  const seen = [];
  for (const n of names) ctl.on(n, (...a) => seen.push([n, ...a]));
  return seen;
};

// ---- controller surface ----
{
  // VideoSurface exists before start() (it must see the first ring): its resize sizes the first ring, since the
  // addon refuses resize() before initialize().
  const lib = fakeLib();
  const ctl = new LibmpvController(lib);
  ctl.resize(1671, 1402);
  assert.equal(lib.calls.filter((c) => c[0] === 'resize').length, 0, 'no native resize before initialize');
  await ctl.start([]);
  assert.deepEqual(lib.calls.find((c) => c[0] === 'initialize'), ['initialize', 1671, 1402], 'first ring at the size set before start');
  ctl.resize(800, 600);
  assert.deepEqual(lib.calls.at(-1), ['resize', 800, 600], 'resize forwarded once started');
  await ctl.quit();
}
{
  const lib = fakeLib();
  const ctl = new LibmpvController(lib, { width: 1920.4, height: 1080 }, '/dev/dri/renderD129');
  assert.equal(lib.renderNode, '/dev/dri/renderD129', 'render node passed to create');
  await assert.rejects(ctl.command('loadfile', 'x'), /mpv non démarré|mpv isn’t running/, 'command before start rejects like MpvController');
  await ctl.start(['--idle=yes', '--wid=1', '--vo=gpu-next']);
  const sets = lib.calls.filter((c) => c[0] === 'setOption').map((c) => `${c[1]}=${c[2]}`);
  assert.ok(sets.includes('idle=yes') && !sets.some((s) => s.startsWith('wid=')) && sets.includes('vo=libmpv') && !sets.includes('vo=gpu-next'), 'options set before initialize');
  const init = lib.calls.findIndex((c) => c[0] === 'initialize');
  assert.ok(init > lib.calls.findLastIndex((c) => c[0] === 'setOption'), 'initialize after every option');
  assert.deepEqual(lib.calls[init], ['initialize', 1920, 1080], 'initialize at the rounded first ring size');

  const url = 'https://example.invalid/v.mkv';
  await ctl.command('loadfile', url, 'replace', -1, 'start=10');
  assert.deepEqual(lib.calls.at(-1), ['command', ['loadfile', url, 'replace', -1, 'start=10']], 'command args passed as one array');
  await assert.rejects(ctl.command('fail'), /invalid parameter/, 'a failed command rejects');
  await ctl.set('pause', true);
  assert.deepEqual(lib.calls.at(-1), ['setProperty', 'pause', true]);
  assert.equal(await ctl.get('volume'), 80, 'get resolves the value');
  await ctl.observe('time-pos');
  assert.deepEqual(lib.calls.at(-1), ['observe', 'time-pos']);

  const seen = record(ctl, ['property', 'event', 'ao-failed', 'vo-failed', 'exit', 'buffers', 'frame']);
  lib.emit({ type: 'property', name: 'time-pos', data: 12.5 });
  const endFile = { event: 'end-file', reason: 'error', file_error: 'no audio or video data played', playlist_entry_id: 1 };
  lib.emit({ type: 'event', name: 'end-file', msg: endFile });
  lib.emit({ type: 'log', prefix: 'ffmpeg', level: 'warn', text: 'Multiple Dolby Vision RPUs found in one AU\n' });
  lib.emit({ type: 'log', prefix: 'ao', level: 'error', text: 'Failed to initialize audio driver \'pipewire\'\n' });
  lib.emit({ type: 'log', prefix: 'cplayer', level: 'error', text: 'Error opening/initializing the selected video_out (--vo) device.\n' });
  const ring = { type: 'buffers', generation: 1, buffers: [] };
  lib.emit(ring);
  lib.emit({ type: 'frame', generation: 1, slot: 0 });
  assert.deepEqual(seen, [
    ['property', 'time-pos', 12.5],
    // MpvPlayer reads msg.reason and msg.file_error as on the JSON IPC.
    ['event', 'end-file', endFile],
    ['ao-failed'],
    ['vo-failed'],
    ['buffers', ring],
    ['frame', { type: 'frame', generation: 1, slot: 0 }],
  ]);
  assert.equal(ctl.lastBuffers, ring, 'latest ring kept for a late VideoSurface');
  lib.emit({ type: 'shutdown' });
  lib.emit({ type: 'shutdown' });
  assert.deepEqual(seen.filter((s) => s[0] === 'exit'), [['exit', 0]], 'shutdown: exit(0), once');
  await assert.rejects(ctl.set('pause', false), /mpv non démarré|mpv isn’t running/, 'nothing reaches a stopped core');
  await ctl.quit();
  assert.ok(lib.calls.some((c) => c[0] === 'destroy'), 'quit destroys the handle');
  assert.ok(!lib.calls.some((c) => c[0] === 'command' && c[1][0] === 'quit'), 'no quit command to a core already gone');
}

// A refused option fails start, as mpv refusing its command line.
{
  const lib = fakeLib();
  lib.failOption = 'bogus';
  const ctl = new LibmpvController(lib);
  await assert.rejects(ctl.start(['--bogus=1']), /mpv option bogus=1: option not found/);
  assert.ok(!lib.calls.some((c) => c[0] === 'initialize'), 'not initialized');
}
// ...unless it is a version-gated one (MpvPlayer marks them): this libmpv may predate it.
{
  const lib = fakeLib();
  lib.failOption = 'target-colorspace-hint-mode';
  const ctl = new LibmpvController(lib);
  ctl.optional = new Set(['target-colorspace-hint-mode']);
  await ctl.start(['--target-colorspace-hint-mode=target', '--glsl-shaders-append=~~/a.glsl']);
  assert.ok(lib.calls.some((c) => c[0] === 'initialize'), 'started without the gated option');
  const init = lib.calls.findIndex((c) => c[0] === 'initialize');
  assert.ok(lib.calls.findIndex((c) => c[0] === 'command' && c[1][0] === 'change-list') > init, 'change-list after initialize');
  assert.ok(lib.calls.some((c) => c[0] === 'command' && JSON.stringify(c[1]) === JSON.stringify(['change-list', 'glsl-shaders', 'append', '~~/a.glsl'])));
  assert.equal(await ctl.get('mpv-version'), 'mpv 0.41.0');
  await ctl.quit();
}

// Render thread failure: fatal, reported like mpv exiting, with 'render-error' first (texture → detached fallback).
{
  const lib = fakeLib();
  const ctl = new LibmpvController(lib);
  await ctl.start([]);
  const seen = record(ctl, ['render-error', 'exit']);
  lib.stuck = 'track-list';
  const inflight = ctl.get('track-list');
  lib.emit({ type: 'error', message: 'eglCreateImage failed' });
  assert.deepEqual(seen, [['render-error', 'eglCreateImage failed'], ['exit', null]]);
  await assert.rejects(inflight, /mpv quit unexpectedly|mpv a quitté/, 'a call in flight rejects when the core is gone');
  assert.ok(lib.calls.some((c) => c[0] === 'destroy'), 'handle destroyed');
  await ctl.quit();
}

// quit: quit command, destroy, exit(0) once, even when the core never answers the command.
{
  const lib = fakeLib();
  lib.quitAnswers = false;
  const ctl = new LibmpvController(lib);
  await ctl.start([]);
  const seen = record(ctl, ['exit']);
  const t0 = Date.now();
  await ctl.quit();
  assert.ok(Date.now() - t0 >= 1400, 'waited for the quit command up to its timeout');
  assert.ok(lib.calls.some((c) => c[0] === 'command' && c[1][0] === 'quit') && lib.calls.at(-1)[0] === 'destroy', 'quit command, then destroy');
  assert.deepEqual(seen, [['exit', 0]]);
}

// ---- hung watchdog (fake clock) ----
mock.timers.enable({ apis: ['setInterval', 'Date'] });
{
  const lib = fakeLib();
  lib.pidAnswers = false;
  const ctl = new LibmpvController(lib);
  await ctl.start([]);
  const seen = record(ctl, ['hung']);
  for (let i = 0; i < 2; i++) mock.timers.tick(5000);
  assert.equal(seen.length, 0, 'not hung at 10 s');
  assert.equal(lib.calls.filter((c) => c[0] === 'getProperty' && c[1] === 'pid').length, 1, 'one ping outstanding at a time');
  lib.stuck = 'track-list';
  const inflight = ctl.get('track-list');
  let settled = null;
  inflight.then(() => (settled = 'resolved'), (err) => (settled = err.message));
  mock.timers.tick(5000);
  assert.deepEqual(seen, [['hung']], 'hung after more than 10 s without an answer');
  await Promise.resolve();
  await Promise.resolve();
  assert.match(String(settled), /mpv quit unexpectedly|mpv a quitté/, 'a call in flight rejects on hung (MpvPlayer.create cannot stall)');
  await assert.rejects(ctl.set('pause', true), /mpv quit unexpectedly|mpv a quitté/, 'and later calls are refused');
  mock.timers.tick(30_000);
  assert.equal(seen.length, 1, 'hung once');
}
{
  const lib = fakeLib();
  const ctl = new LibmpvController(lib);
  await ctl.start([]);
  const seen = record(ctl, ['hung']);
  for (let i = 0; i < 12; i++) {
    mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(seen.length, 0, 'an answering core is never hung');
  assert.ok(lib.calls.filter((c) => c[1] === 'pid').length >= 10, 'pinged every 5 s');
  // A suspended machine: one late tick restarts the clock instead of declaring a hang.
  lib.pidAnswers = false;
  mock.timers.tick(5000);
  mock.timers.tick(60_000);
  assert.equal(seen.length, 0, 'a late tick after sleep is not a hang');
  await ctl.quit();
}
mock.timers.reset();

// ---- VideoSurface ----
const flush = () => new Promise((r) => setImmediate(r));
// Electron's reference model (shared-texture.ts.browser): main holds one reference from import; a send adds a
// renderer reference only once the renderer answered; allReferencesReleased fires when both are gone. The send
// resolves on the renderer's answer, before it drew anything, so resolving must never free the slot by itself.
function fakeElectron() {
  const screen = new EventEmitter();
  screen.scale = 1.5;
  screen.getDisplayMatching = () => ({ scaleFactor: screen.scale });
  const imports = [];
  const sends = [];
  const sharedTexture = {
    failImport: false,
    importSharedTexture(o) {
      if (sharedTexture.failImport) throw new Error('import refused');
      const imp = {
        info: o.textureInfo,
        main: true,
        renderer: 0,
        freed: false,
        check() {
          if (!imp.main && imp.renderer === 0 && !imp.freed) {
            imp.freed = true;
            o.allReferencesReleased?.();
          }
        },
        release() {
          if (!imp.main) throw new Error('Shared texture not found');
          imp.main = false;
          imp.check();
        },
        // The preload's importedSharedTexture.release(), after its GPU work.
        rendererRelease() {
          assert.ok(imp.renderer > 0, 'renderer release without a renderer reference');
          imp.renderer--;
          imp.check();
        },
      };
      imports.push(imp);
      return imp;
    },
    sendSharedTexture(o, meta) {
      const imp = o.importedSharedTexture;
      let settle;
      const p = new Promise((resolve, reject) => (settle = { resolve, reject }));
      sends.push({
        imp,
        frame: o.frame,
        meta,
        resolve: () => {
          imp.renderer++;
          settle.resolve();
        },
        reject: settle.reject,
      });
      return p;
    },
  };
  globalThis.__electron = { screen, sharedTexture };
  return { screen, imports, sends, sharedTexture };
}
function fakeWindow() {
  const win = new EventEmitter();
  win.size = [1000, 600];
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.getContentBounds = () => ({ x: 0, y: 0, width: win.size[0], height: win.size[1] });
  win.webContents = { mainFrame: { url: 'app://wicaby/osd?osd=1&video=1' }, ipc: new EventEmitter() };
  return win;
}
const buf = (slot, w = 1500, h = 900) => ({ slot, fd: 40 + slot, stride: w * 4, offset: 0, size: w * h * 4, modifier: '216172782128496660', width: w, height: h, fourcc: 'AB24' });
{
  const fx = fakeElectron();
  const lib = fakeLib();
  const ctl = new LibmpvController(lib);
  await ctl.start([]);
  lib.emit({ type: 'buffers', generation: 1, buffers: [0, 1, 2, 3].map((s) => buf(s)) });
  const win = fakeWindow();
  const isAppUrl = (u) => u.startsWith('app://wicaby/');
  const surface = new VideoSurface(win, ctl, isAppUrl);
  const fatal = [];
  surface.on('fatal', (m) => fatal.push(m));
  assert.equal(fx.imports.length, 0, 'nothing imported before a frame (per-frame import)');
  assert.deepEqual(lib.calls.filter((c) => c[0] === 'resize'), [['resize', 1500, 900]], 'ring at content size × scale');

  const released = () => lib.calls.filter((c) => c[0] === 'releaseFrame').map((c) => `${c[1]}:${c[2]}`);
  // A ring that landed before the surface is used.
  lib.emit({ type: 'frame', generation: 1, slot: 2 });
  assert.equal(fx.imports.length, 1, 'one import per frame');
  assert.deepEqual(fx.imports[0].info, {
    pixelFormat: 'rgba',
    codedSize: { width: 1500, height: 900 },
    visibleRect: { x: 0, y: 0, width: 1500, height: 900 },
    handle: { nativePixmap: { planes: [{ fd: 42, stride: 6000, offset: 0, size: 1500 * 900 * 4 }], modifier: '216172782128496660', supportsZeroCopyWebGpuImport: false } },
  });
  assert.equal(fx.sends.length, 1, 'frame sent');
  assert.equal(fx.sends[0].imp, fx.imports[0]);
  assert.equal(fx.sends[0].frame, win.webContents.mainFrame);
  assert.deepEqual(fx.sends[0].meta, { generation: 1, slot: 2 });
  lib.emit({ type: 'frame', generation: 1, slot: 2 });
  assert.equal(fx.imports.length + fx.sends.length, 2, 'never two imports of one slot at once');
  fx.sends[0].resolve();
  await flush();
  assert.equal(fx.imports[0].main, false, 'main reference released once the send settled');
  assert.deepEqual(released(), [], 'slot still held: the renderer has not released the frame');
  fx.imports[0].rendererRelease();
  assert.deepEqual(released(), ['1:2'], 'slot back to libmpv only from allReferencesReleased');

  // A failed send: no renderer reference, so main's release frees the slot.
  lib.emit({ type: 'frame', generation: 1, slot: 3 });
  fx.sends[1].reject(new Error('Shared texture not found'));
  await flush();
  assert.deepEqual(released(), ['1:2', '1:3'], 'released after a failed send too');

  // An import that throws: slot back at once.
  fx.sharedTexture.failImport = true;
  lib.emit({ type: 'frame', generation: 1, slot: 1 });
  fx.sharedTexture.failImport = false;
  assert.equal(released().at(-1), '1:1', 'failed import released at once');
  assert.equal(fx.sends.length, 2, 'and not sent');

  // Another page in the window: frames are dropped, never imported or sent.
  win.webContents.mainFrame.url = 'https://example.invalid/';
  lib.emit({ type: 'frame', generation: 1, slot: 0 });
  assert.equal(fx.imports.length, 2, 'nothing imported for a foreign page');
  assert.equal(released().at(-1), '1:0', 'dropped frame released at once');
  win.webContents.mainFrame.url = 'app://wicaby/osd?osd=1&video=1';

  // A delivery brings the failure streak to zero.
  lib.emit({ type: 'frame', generation: 1, slot: 0 });
  fx.sends.at(-1).resolve();
  await flush();
  fx.imports.at(-1).rendererRelease();

  // Resize: debounced; a frame of the old ring in flight still completes after the new ring arrives.
  lib.emit({ type: 'frame', generation: 1, slot: 1 });
  const oldSend = fx.sends.at(-1);
  win.size = [1200, 700];
  win.emit('resize');
  win.emit('resize');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(lib.calls.filter((c) => c[0] === 'resize').at(-1), ['resize', 1800, 1050], 'resized once after the debounce');
  assert.equal(lib.calls.filter((c) => c[0] === 'resize').length, 2);
  lib.emit({ type: 'buffers', generation: 2, buffers: [0, 1, 2, 3].map((s) => buf(s, 1800, 1050)) });
  const sendsBefore = fx.sends.length;
  lib.emit({ type: 'frame', generation: 1, slot: 0 });
  assert.equal(fx.sends.length, sendsBefore, 'a stale generation is not sent');
  assert.equal(released().at(-1), '1:0', 'but released');
  oldSend.resolve();
  await flush();
  oldSend.imp.rendererRelease();
  assert.equal(released().at(-1), '1:1', 'the old ring\'s frame in flight is released normally');
  lib.emit({ type: 'frame', generation: 2, slot: 0 });
  assert.deepEqual(fx.sends.at(-1).imp.info.codedSize, { width: 1800, height: 1050 }, 'new ring used');
  fx.sends.at(-1).resolve();
  await flush();
  fx.sends.at(-1).imp.rendererRelease();
  assert.equal(released().at(-1), '2:0');

  // Scale change: same DIP size, new pixel count.
  fx.screen.scale = 2;
  fx.screen.emit('display-metrics-changed');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(lib.calls.filter((c) => c[0] === 'resize').at(-1), ['resize', 2400, 1400]);

  // A ring resize the addon could not allocate (non-fatal log): the next geometry event asks again, same size or not.
  const resizes = () => lib.calls.filter((c) => c[0] === 'resize').length;
  const before = resizes();
  lib.emit({ type: 'log', prefix: 'wicaby-render', level: 'warn', text: 'resize to 2400x1400 failed, keeping 1800x1050: gbm_bo_create failed' });
  fx.screen.emit('display-metrics-changed');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(resizes(), before + 1, 'same size retried after a failed resize');

  // Persistent failure: 'fatal' once, after 60 frames in a row.
  for (let i = 0; i < 70; i++) {
    lib.emit({ type: 'frame', generation: 2, slot: 1 });
    fx.sends.at(-1).reject(new Error('Shared texture not found'));
    await flush();
  }
  assert.equal(fatal.length, 1, 'fatal emitted once');
  assert.match(fatal[0], /60 in a row/);

  // #14: the playback page reports a frame it could not draw: fatal at once (mpv's own window takes over).
  {
    const w2 = fakeWindow();
    const s2 = new VideoSurface(w2, ctl, isAppUrl);
    const f2 = [];
    s2.on('fatal', (m) => f2.push(m));
    w2.webContents.ipc.emit('video:draw-failed', {}, 'OperationError: import failed');
    w2.webContents.ipc.emit('video:draw-failed', {}, 'again');
    assert.equal(f2.length, 1, 'a draw failure is fatal, once');
    assert.match(f2[0], /not drawn.*import failed/);
    s2.destroy();
    assert.equal(w2.webContents.ipc.listenerCount('video:draw-failed'), 0, 'destroy stops listening');
  }

  // Electron's transfer timeout: the renderer may still draw it late, so the slot is held a while longer.
  mock.timers.enable({ apis: ['setTimeout'] });
  lib.emit({ type: 'frame', generation: 2, slot: 2 });
  const late = fx.sends.at(-1);
  late.reject(new Error('transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'));
  await flush();
  assert.equal(late.imp.main, true, 'a timed-out import is held');
  assert.notEqual(released().at(-1), '2:2');
  mock.timers.tick(2000);
  assert.equal(late.imp.main, false, 'and released after the hold');
  assert.equal(released().at(-1), '2:2');
  lib.emit({ type: 'frame', generation: 2, slot: 3 });
  const held = fx.sends.at(-1);
  held.reject(new Error('transfer shared texture timed out after 1000ms'));
  await flush();
  mock.timers.reset();

  // destroy: stops sending, releases held imports; a send in flight still settles and frees its slot.
  lib.emit({ type: 'frame', generation: 2, slot: 0 });
  const inflight = fx.sends.at(-1);
  surface.destroy();
  assert.equal(held.imp.main, false, 'held import released by destroy');
  assert.equal(released().at(-1), '2:3');
  lib.emit({ type: 'frame', generation: 2, slot: 1 });
  assert.equal(fx.sends.at(-1), inflight, 'nothing sent after destroy');
  inflight.resolve();
  await flush();
  assert.equal(inflight.imp.main, false, 'in-flight send released after destroy');
  inflight.imp.rendererRelease();
  assert.equal(released().at(-1), '2:0', 'its slot freed through allReferencesReleased');
  assert.ok(fx.imports.every((i) => !i.main), 'no main reference left');
  assert.equal(win.listenerCount('resize') + fx.screen.listenerCount('display-metrics-changed') + ctl.listenerCount('frame') + ctl.listenerCount('buffers') + ctl.listenerCount('render-warning'), 0, 'no listener left');
  await ctl.quit();
}

// Every transport says so: MpvPlayer types its ctl with MpvTransport.
const controllerSrc = fs.readFileSync(path.join(desktop, 'src/main/playback/mpv-controller.ts'), 'utf8');
assert.match(controllerSrc, /export interface MpvTransport extends EventEmitter/);
assert.match(controllerSrc, /class MpvController extends EventEmitter implements MpvTransport/);
assert.match(fs.readFileSync(path.join(desktop, 'src/main/playback/libmpv-controller.ts'), 'utf8'), /class LibmpvController extends EventEmitter implements MpvTransport/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('libmpv controller checks passed');
