// Standalone check of build/Release/wicaby_mpv.node, silent (ao=null) and on
// local lavfi media only. Run with Node (`node test/smoke.cjs`) or from
// Electron's main process (test/electron-main.cjs). Exits non-zero on failure.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ADDON = process.env.WICABY_MPV_ADDON || path.join(__dirname, '..', 'build', 'Release', 'wicaby_mpv.node');
const SOURCE = 'av://lavfi:testsrc=size=1280x720:rate=30:duration=4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fdCount = () => fs.readdirSync('/proc/self/fd').length;

// dmabuf and DRM fds of this process without FD_CLOEXEC (they would leak into children).
function inheritableGpuFds() {
  const leaked = [];
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let target;
    try {
      target = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue;
    }
    if (!target.startsWith('/dmabuf:') && !target.startsWith('/dev/dri/')) continue;
    let flags = '';
    try {
      flags = /^flags:\s+(\d+)/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1] ?? '';
    } catch {
      continue;
    }
    if (!(parseInt(flags, 8) & 0o2000000)) leaked.push(`${fd} ${target}`);
  }
  return leaked;
}

function check(ok, what, detail) {
  if (!ok) throw new Error(`FAIL ${what}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`ok   ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`FAIL timeout waiting for ${what}`);
    await sleep(10);
  }
}

// One full player lifecycle; returns what it saw.
async function cycle(native, log) {
  // hold: an array while frames are kept (never released), else null.
  const seen = { buffers: [], frames: 0, framesByGen: {}, props: [], events: [], logs: [], errors: [], shutdown: 0, staleFrames: 0, probes: [], hold: null };
  let player;
  let currentGen = 0;
  const onEvent = (e) => {
    switch (e.type) {
      case 'buffers':
        currentGen = e.generation;
        seen.buffers.push(e);
        break;
      case 'frame':
        if (e.generation !== currentGen) seen.staleFrames++;
        seen.frames++;
        seen.framesByGen[e.generation] = (seen.framesByGen[e.generation] || 0) + 1;
        if ('probe' in e) seen.probes.push(e);
        if (seen.hold) seen.hold.push(e);
        // Hold the frame briefly, like a send to the renderer would.
        else setTimeout(() => player.releaseFrame(e.generation, e.slot), 2);
        break;
      case 'property':
        seen.props.push(e);
        break;
      case 'event':
        seen.events.push(e);
        break;
      case 'log':
        seen.logs.push(e);
        break;
      case 'error':
        seen.errors.push(e);
        break;
      case 'shutdown':
        seen.shutdown++;
        break;
    }
  };
  player = native.create(onEvent);
  player.setOption('vo', 'libmpv');
  player.setOption('ao', 'null');
  player.setOption('terminal', 'no');
  player.setOption('idle', 'yes');
  player.setOption('hwdec', process.env.WICABY_TEST_HWDEC || 'no');
  let threw = null;
  try {
    player.setOption('no-such-option-xyz', '1');
  } catch (err) {
    threw = err.message;
  }
  if (log) check(threw && /option/.test(threw), 'setOption rejects an unknown option', threw);
  const t0 = Date.now();
  player.initialize(1280, 720);
  if (log) console.log(`     initialize() returned in ${Date.now() - t0} ms`);
  player.observe('time-pos');
  player.observe('pause');
  await player.command(['loadfile', SOURCE]);
  return { player, seen, getGen: () => currentGen };
}

async function run(native) {
  const fds0 = fdCount();
  check(typeof native.probe === 'function' && typeof native.create === 'function', 'exports probe/create');
  const probe = native.probe();
  check(probe.ok === true && probe.apiVersion >= ((2 << 16) | 1) && !('error' in probe), 'probe: libmpv >= 2.1', probe);
  check(
    probe.render && probe.render.ok === true && /^\/dev\/dri\/renderD\d+$/.test(probe.render.node) && !('error' in probe.render),
    'probe: render node usable',
    probe.render,
  );
  const named = native.probe(probe.render.node);
  check(named.render.ok === true && named.render.node === probe.render.node, 'probe(renderNode) checks that node', named.render);
  const bogus = native.probe('/dev/dri/no-such-node');
  check(
    bogus.ok === true && bogus.render.ok === false && bogus.render.node === '/dev/dri/no-such-node' && /no-such-node/.test(bogus.render.error),
    'probe(bogus node): render.ok false with the reason',
    bogus.render,
  );

  // --- Lifecycle 1: frames, properties, resize, end-file shapes. ---
  const { player, seen, getGen } = await cycle(native, true);
  await waitFor(() => seen.buffers.length >= 1, 3000, 'buffers');
  const b = seen.buffers[0];
  check(b.generation === 1 && b.buffers.length === 6, 'buffers event: generation 1, 6 slots');
  const s = b.buffers[0];
  check(
    s.width === 1280 && s.height === 720 && s.fourcc === 'AB24' && s.fd > 2 && s.stride >= 1280 * 4 &&
      typeof s.modifier === 'string' && /^\d+$/.test(s.modifier) && s.size >= s.stride * 720,
    'buffer shape',
    s,
  );
  check(new Set(b.buffers.map((x) => x.fd)).size === 6, 'distinct fds per slot');
  const info = seen.logs.filter((l) => l.prefix === 'wicaby-render-info' && l.level === 'info').map((l) => l.text);
  check(info.some((t) => /^GPU sync: (EGL_ANDROID_native_fence_sync|glFinish)/.test(t)), 'GPU sync info log', info[0]);
  const ringLog = info.find((t) => t.startsWith('ring 1: '));
  check(
    /^ring 1: 1280x720, (linear|modifiers|implicit) allocation, modifier 0x[0-9a-f]+, stride \d+, size \d+/.test(ringLog ?? '') &&
      ringLog.includes(`modifier 0x${BigInt(s.modifier).toString(16)},`),
    'ring info log matches the buffers',
    ringLog,
  );
  check(!seen.logs.some((l) => l.prefix === 'wicaby-render'), 'no render warnings');

  const tStart = Date.now();
  await sleep(2000);
  const in2s = seen.frames;
  check(in2s >= 30, `>= 30 frames in 2 s (${in2s})`);
  const timePos = seen.props.filter((p) => p.name === 'time-pos' && typeof p.data === 'number');
  check(timePos.length > 0 && timePos.at(-1).data > 0.5, 'time-pos property events', timePos.at(-1));
  check(seen.props.some((p) => p.name === 'pause' && p.data === false), 'pause property is a boolean');
  check(seen.events.some((e) => e.name === 'start-file' && typeof e.msg.playlist_entry_id === 'number'), 'start-file event');
  check(seen.events.some((e) => e.name === 'file-loaded' && e.msg.event === 'file-loaded'), 'file-loaded event');
  const leaked = inheritableGpuFds();
  check(leaked.length === 0, 'no dmabuf/DRM fd without CLOEXEC during playback', leaked);

  const version = await player.getProperty('mpv-version');
  check(typeof version === 'string' && version.startsWith('mpv'), 'getProperty string', version);
  const params = await player.getProperty('video-params');
  check(params && params.w === 1280 && params.h === 720, 'getProperty map (video-params)', { w: params?.w, h: params?.h });
  const tracks = await player.getProperty('track-list');
  check(Array.isArray(tracks) && tracks.length >= 1, 'getProperty array (track-list)');
  await player.setProperty('speed', 1.0);
  await player.setProperty('volume', 50);
  check((await player.getProperty('volume')) === 50, 'setProperty then getProperty');
  let rejected = null;
  try {
    await player.command(['no-such-command']);
  } catch (err) {
    rejected = err.message;
  }
  check(typeof rejected === 'string', 'bad command rejects', rejected);
  rejected = null;
  try {
    await player.getProperty('no-such-property');
  } catch (err) {
    rejected = err.message;
  }
  check(rejected === 'property not found', 'missing property rejects', rejected);

  // Resize: a new generation, frames move to it, old slots are not reused.
  const framesBefore = seen.frames;
  player.resize(960, 540);
  await waitFor(() => seen.buffers.length >= 2, 2000, 'resize buffers');
  const b2 = seen.buffers[1];
  check(b2.generation === 2 && b2.buffers[0].width === 960 && b2.buffers[0].height === 540, 'resize: generation 2 at 960x540');
  await waitFor(() => (seen.framesByGen[2] || 0) >= 5, 2000, 'frames of generation 2');
  check(seen.staleFrames === 0, 'no frames of a stale generation reach JS', seen.framesByGen);
  check(getGen() === 2 && seen.frames > framesBefore, 'frames continue after resize');
  player.resize(960, 540); // same size: no new generation
  await sleep(100);
  check(seen.buffers.length === 2, 'same-size resize is a no-op');

  // EOF end-file (the lavfi source lasts 4 s).
  await waitFor(() => seen.events.some((e) => e.name === 'end-file'), 6000, 'end-file eof');
  const eof = seen.events.find((e) => e.name === 'end-file');
  check(eof.msg.event === 'end-file' && eof.msg.reason === 'eof' && typeof eof.msg.playlist_entry_id === 'number' && !('file_error' in eof.msg), 'end-file eof shape', eof.msg);
  console.log(`     ${seen.frames} frames in ${((Date.now() - tStart) / 1000).toFixed(1)} s`);

  // Error end-file.
  await player.command(['loadfile', '/nonexistent/wicaby-test.mkv']);
  await waitFor(() => seen.events.filter((e) => e.name === 'end-file').length >= 2, 4000, 'end-file error');
  const err = seen.events.filter((e) => e.name === 'end-file')[1];
  check(err.msg.reason === 'error' && typeof err.msg.file_error === 'string', 'end-file error shape', err.msg);
  check(seen.errors.length === 0, 'no render errors', seen.errors);

  const d1 = player.destroy();
  const d2 = player.destroy();
  await Promise.all([d1, d2]);
  await player.destroy();
  check(true, 'destroy resolves and is idempotent');
  rejected = null;
  try {
    await player.command(['stop']);
  } catch (e) {
    rejected = e.message;
  }
  check(rejected === 'player destroyed', 'command after destroy rejects', rejected);
  // Silent no-ops after destroy: in-flight sharedTexture imports release their slot late.
  for (const [what, fn] of [
    ['releaseFrame', () => player.releaseFrame(2, 0)],
    ['releaseFrame (bogus args)', () => player.releaseFrame(99, 99)],
    ['resize', () => player.resize(100, 100)],
    ['observe', () => player.observe('pause')],
  ]) {
    let threw = null;
    try {
      fn();
    } catch (e) {
      threw = e.message;
    }
    check(threw === null, `${what} after destroy is a silent no-op`, threw ?? undefined);
  }
  const fds1 = fdCount();

  // --- Lifecycle 2: destroy while playing, with frames held; fd balance. ---
  const c2 = await cycle(native, false);
  await waitFor(() => c2.seen.frames >= 10, 3000, 'second player frames');
  // Resize storm while frames are in flight: rings retire out of order.
  for (let i = 0; i < 20; i++) {
    c2.player.resize(640 + 16 * i, 360 + 8 * (i % 5));
    await sleep(i % 3 === 0 ? 0 : 15);
  }
  await waitFor(() => c2.seen.buffers.at(-1)?.buffers[0].width === 640 + 16 * 19, 3000, 'last resize');
  const lastGen = c2.seen.buffers.at(-1).generation;
  await waitFor(() => (c2.seen.framesByGen[lastGen] || 0) >= 3, 3000, 'frames after resize storm');
  check(c2.seen.staleFrames === 0 && c2.seen.errors.length === 0, `resize storm: ${c2.seen.buffers.length} generations, no stale frames or errors`);

  // JS holds every slot: no slot is announced twice, mpv keeps playing (it
  // renders into a scratch target meanwhile), and frames resume on release.
  const lastPos = () => c2.seen.props.filter((p) => p.name === 'time-pos' && typeof p.data === 'number').at(-1)?.data ?? 0;
  c2.seen.hold = [];
  const posHold = lastPos();
  await sleep(700);
  const held = c2.seen.hold;
  c2.seen.hold = null;
  check(held.length === 6 && new Set(held.map((e) => e.slot)).size === 6, 'holding frames: exactly the 6 slots are announced', held.length);
  check(lastPos() - posHold > 0.3, 'playback continues while every slot is held', { from: posHold, to: lastPos() });
  const framesHeld = c2.seen.frames;
  for (const e of held) c2.player.releaseFrame(e.generation, e.slot);
  await waitFor(() => c2.seen.frames >= framesHeld + 5, 2000, 'frames after releasing held slots');

  // Pixel probe, while paused: answered by a redraw, on one frame only.
  await c2.player.setProperty('pause', true);
  await sleep(150);
  check(c2.player.probeNextFrame() === undefined && c2.seen.probes.length === 0, 'probeNextFrame returns undefined');
  await waitFor(() => c2.seen.probes.length >= 1, 2000, 'probed frame');
  c2.player.probeNextFrame();
  await waitFor(() => c2.seen.probes.length >= 2, 2000, 'second probed frame');
  const probed = c2.seen.probes[0];
  const ring = c2.seen.buffers.find((x) => x.generation === probed.generation).buffers[0];
  const where = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.34], [0.5, 0.66]].map(([fx, fy]) => [Math.floor(fx * ring.width), Math.floor(fy * ring.height)]);
  const p = probed.probe;
  check(
    Array.isArray(p) && p.length === 25 && p.every((n) => Number.isInteger(n)) &&
      where.every(([x, y], i) => p[i * 5] === x && p[i * 5 + 1] === y && [2, 3, 4].every((k) => p[i * 5 + k] >= 0 && p[i * 5 + k] <= 255)),
    'probe: [x,y,r,g,b] x5 at the agreed points',
    p,
  );
  // testsrc is lit nearly everywhere; letterboxing at this size leaves the probe points inside the picture.
  check(where.some((_, i) => Math.max(p[i * 5 + 2], p[i * 5 + 3], p[i * 5 + 4]) > 40), 'probe reads a lit picture');
  check(Object.keys(probed).sort().join() === 'generation,probe,slot,type', 'probed frame event shape', Object.keys(probed));
  const pending = c2.player.getProperty('time-pos');
  await c2.player.destroy();
  await pending.catch(() => {});
  const fds2 = fdCount();
  check(fds2 === fds1, `fd count stable across a create/destroy cycle (${fds0} at start, ${fds1} after 1st, ${fds2} after 2nd)`);

  // --- Lifecycle 3: destroy before initialize, and a player whose render node is bogus. ---
  const p3 = native.create(() => {});
  await p3.destroy();
  const bad = { errors: [], ended: [] };
  const p4 = native.create((e) => {
    if (e.type === 'error') bad.errors.push(e.message);
    if (e.type === 'event' && e.name === 'end-file') bad.ended.push(e.msg);
  }, '/dev/dri/no-such-node');
  p4.setOption('vo', 'libmpv');
  p4.setOption('ao', 'null');
  p4.initialize(64, 64);
  const loaded = p4.command(['loadfile', SOURCE]);
  await waitFor(() => bad.errors.length > 0, 2000, 'render error');
  check(/no-such-node/.test(bad.errors[0]), 'bad render node reports an error event', bad.errors[0]);
  await loaded.catch(() => {});
  await p4.destroy();
  const fds3 = fdCount();
  check(fds3 === fds1, `fd count stable after failed player (${fds3})`);
  console.log('PASS');
}

module.exports = { run, ADDON };

if (require.main === module) {
  run(require(ADDON)).then(
    () => {
      require('./exit-hang.cjs').main();
      // Destroyed players must not keep the event loop alive: Node should
      // exit on its own before this unref'd timer fires.
      setTimeout(() => {
        console.error('FAIL event loop still alive after destroy');
        process.exit(1);
      }, 3000).unref();
    },
    (err) => {
      console.error(err.stack || String(err));
      process.exit(1);
    },
  );
}
