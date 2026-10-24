// Self-check for the Linux desktop integration, with win32 and linux cases side by side:
// - media keys: global shortcuts only for mpv in WASAPI exclusive mode on Windows, never on Linux (MPRIS);
// - XDG autostart entry: Exec quoting, $APPIMAGE, and the desktop's "disabled" markers;
// - refresh-rate matching: session detection, xrandr and kscreen-doctor parsing, rate choice.
// - Ozone platform and its relaunch, the render node, GPU recovery levels and the texture-mode memory.
// Usage: node tools/checks/linux-desktop-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-linux-desktop-'));
// CommonJS stub: any Electron name a bundled module imports resolves (to undefined unless listed).
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `module.exports = { app: { isPackaged: true, isReady: () => false, getLocale: () => 'fr', getAppPath: () => '/app', getPath: () => '${tmp.replace(/\\/g, '/')}', on() {} } };`,
      loader: 'js',
    }));
  },
};
async function load(entry) {
  const out = path.join(tmp, `${path.basename(entry, '.ts')}.mjs`);
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
  return import(pathToFileURL(out).href);
}

// ---- Media keys ----
const { needsGlobalMediaKeys } = await load('src/main/features/tray.ts');
const mpv = { active: true, player: 'mpv' };
assert.equal(needsGlobalMediaKeys(mpv, true, 'win32'), true, 'win32: WASAPI exclusive takes the keys globally');
assert.equal(needsGlobalMediaKeys(mpv, false, 'win32'), false, 'win32: shared mode goes through SMTC');
assert.equal(needsGlobalMediaKeys({ active: true, player: 'html' }, true, 'win32'), false);
assert.equal(needsGlobalMediaKeys(mpv, true, 'linux'), false, 'linux: always MPRIS');
assert.equal(needsGlobalMediaKeys(mpv, false, 'linux'), false);

// ---- Autostart ----
const { desktopExec, autostartEntry, autostartEnabled } = await load('src/main/features/startup.ts');
assert.equal(desktopExec(['/opt/Wicaby/wicaby', '--hidden']), '"/opt/Wicaby/wicaby" "--hidden"');
// " ` $ \ are backslash-escaped inside quotes, % doubled, then every backslash doubled again.
assert.equal(desktopExec(['/home/a b/$x"`%\\']), String.raw`"/home/a b/\\$x\\"\\` + '`' + String.raw`%%\\\\"`);
const plain = autostartEntry('Wicaby', '/opt/Wicaby/wicaby', ['--hidden'], {});
assert.match(plain, /^\[Desktop Entry\]\n/);
assert.match(plain, /^Exec="\/opt\/Wicaby\/wicaby" "--hidden"$/m);
assert.match(plain, /^Type=Application$/m);
const appimage = autostartEntry('Wicaby', '/tmp/.mount_WicabyX/wicaby', ['--hidden'], { APPIMAGE: '/home/u/Apps/Wicaby.AppImage' });
assert.match(appimage, /^Exec="\/home\/u\/Apps\/Wicaby.AppImage" "--no-sandbox" "--hidden"$/m, 'the AppImage file, not its temporary mount, as its own entry runs it');
assert.equal(autostartEnabled(null), false);
assert.equal(autostartEnabled(plain), true);
assert.equal(autostartEnabled(`${plain}Hidden=true\n`), false);
assert.equal(autostartEnabled(plain.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false')), false);

// ---- Refresh-rate matching ----
const { linuxDisplayTool, parseXrandr, parseKscreen, outputAt, pickRate, ozonePlatform, ozonePlan, mpvRenderMode, pickRenderNode } = await load('src/main/features/display-mode-linux.ts');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), 'xrandr');
assert.equal(linuxDisplayTool({ DISPLAY: ':0' }), 'xrandr');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }), 'kscreen-doctor');
assert.equal(linuxDisplayTool({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), null, 'GNOME on Wayland: no tool');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'tty' }), null);

// ---- Ozone backend (WICABY_OZONE) ----
const kde = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0' };
const sockets = new Set(['/run/user/1000/wayland-0', '/tmp/wl.sock']);
const has = (f) => sockets.has(f);
assert.equal(ozonePlatform(kde, has), 'wayland', 'Wayland session: native Wayland even with XWayland (#14)');
assert.equal(ozonePlatform({ ...kde, DISPLAY: undefined }, has), 'wayland', 'no X server: native Wayland');
assert.equal(ozonePlatform({ ...kde, XDG_SESSION_TYPE: 'x11' }, has), 'x11', 'X11 session: X11');
assert.equal(ozonePlatform({ ...kde, WAYLAND_DISPLAY: 'wayland-1' }, has), 'x11', 'no Wayland socket: X11');
assert.equal(ozonePlatform({ ...kde, XDG_RUNTIME_DIR: undefined }, has), 'x11', 'a relative socket needs XDG_RUNTIME_DIR');
assert.equal(ozonePlatform({ WAYLAND_DISPLAY: '/tmp/wl.sock' }, has), 'wayland', 'an absolute socket path');
assert.equal(ozonePlatform({ WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000' }, has), 'auto', 'neither socket nor X server: Chromium decides');
assert.equal(ozonePlatform({ DISPLAY: ':0' }, has), 'x11');
assert.equal(ozonePlatform({}, has), 'auto');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: ' Wayland ' }, has), 'wayland');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'auto' }, has), 'auto');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'bogus' }, has), 'wayland', 'unknown value: the default');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'x11' }, has), 'x11');
// The platform Electron already runs on, and the one relaunch that fixes a mismatch.
const argv = ['/opt/Wicaby/wicaby', '--hidden'];
assert.deepEqual(ozonePlan(kde, argv, '', 'wayland'), { effective: 'wayland', relaunchWith: null }, 'Wayland session: Electron already on Wayland');
assert.deepEqual(ozonePlan({ ...kde, XDG_SESSION_TYPE: undefined }, argv, '', 'wayland'), { effective: 'x11', relaunchWith: 'wayland' }, 'no session type: Electron on X11, relaunch on Wayland');
assert.deepEqual(ozonePlan(kde, argv, '', 'x11'), { effective: 'wayland', relaunchWith: 'x11' }, 'WICABY_OZONE=x11 in a Wayland session: relaunch, never a split browser/GPU platform');
assert.deepEqual(ozonePlan(kde, argv, '', 'auto'), { effective: 'wayland', relaunchWith: null }, 'auto: whatever Electron chose');
assert.deepEqual(ozonePlan(kde, [...argv, '--ozone-platform=x11'], 'x11', 'wayland'), { effective: 'x11', relaunchWith: null }, 'a command line naming the platform is taken as is (no relaunch loop)');
assert.deepEqual(ozonePlan(kde, [...argv, '--ozone-platform', 'x11'], '', 'x11'), { effective: 'wayland', relaunchWith: null }, 'even in its two-argument form');
assert.deepEqual(ozonePlan({ DISPLAY: ':0' }, argv, 'Wayland', 'x11'), { effective: 'wayland', relaunchWith: null }, 'a switch set some other way is in effect too');

// ---- mpv video mode (WICABY_MPV_RENDER) ----
const render = { ok: true, node: '/dev/dri/renderD128' };
const loads = () => ({ ok: true, render });
const fails = () => ({ ok: false, error: 'libmpv.so.2: cannot open' });
const noNode = () => ({ ok: true, render: { ok: false, node: '/dev/dri/renderD128', error: 'eglInitialize failed' } });
let probed = 0;
const counted = () => (probed++, { ok: true, render });
assert.equal(mpvRenderMode({}, false, counted).mode, 'wid', 'X11 windows: embedded');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'texture' }, false, counted).mode, 'wid', 'no texture without native Wayland');
assert.equal(probed, 0, 'X11 never loads the addon');
assert.equal(mpvRenderMode({}, true, loads).mode, 'texture');
assert.match(mpvRenderMode({}, true, loads).reason, /renderD128/, 'the render node is logged');
assert.equal(mpvRenderMode({}, true, fails).mode, 'detached', 'no addon: mpv in its own window');
assert.match(mpvRenderMode({}, true, fails).reason, /cannot open/, 'the probe reason, not a generic one (#33/#59)');
assert.equal(mpvRenderMode({}, true, noNode).mode, 'detached', 'libmpv but no usable render node (D2)');
assert.match(mpvRenderMode({}, true, noNode).reason, /eglInitialize failed/);
assert.equal(mpvRenderMode({}, true, () => ({ ok: true })).mode, 'detached', 'a probe without a render check is not trusted');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: ' Detached ' }, true, counted).mode, 'detached');
assert.equal(probed, 0, 'forced detached never loads the addon');
assert.equal(mpvRenderMode({}, true, counted, false).mode, 'detached', 'GPU acceleration off: no dmabuf import (#54)');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'texture' }, true, counted, false).mode, 'detached', 'forced texture cannot override GPU off');
assert.equal(probed, 0, 'GPU off never loads the addon');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'texture' }, true, fails).mode, 'detached', 'forced texture still needs the addon (#79)');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'texture' }, true, fails).warn, true, 'a forced texture that falls back is a warning');
assert.ok(!mpvRenderMode({}, true, fails).warn, 'the automatic fallback is not');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'wid' }, true, loads).mode, 'texture', 'no X11 id on native Wayland');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'bogus' }, true, loads).mode, 'texture', 'unknown value ignored');
// A texture mode that failed for good on this machine (texture-check.json): mpv's own window, unless forced.
assert.equal(mpvRenderMode({}, true, counted, true, 'picture check failed').mode, 'detached', 'a remembered failure');
assert.match(mpvRenderMode({}, true, counted, true, 'picture check failed').reason, /picture check failed/);
assert.equal(probed, 0, 'a remembered failure never loads the addon');
assert.equal(mpvRenderMode({ WICABY_MPV_RENDER: 'texture' }, true, loads, true, 'picture check failed').mode, 'texture', 'WICABY_MPV_RENDER=texture tries again');

// #14: one render node for Chromium and libmpv, from a fake sysfs.
{
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-drm-'));
  const node = (n, driver, boot) => {
    const dev = path.join(sys, 'class', 'drm', n, 'device');
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'uevent'), `DRIVER=${driver}\nPCI_ID=0000:0000\n`);
    if (boot !== undefined) fs.writeFileSync(path.join(dev, 'boot_vga'), `${boot}\n`);
  };
  const modeset = (v) => {
    fs.mkdirSync(path.join(sys, 'module', 'nvidia_drm', 'parameters'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'module', 'nvidia_drm', 'parameters', 'modeset'), `${v}\n`);
  };
  assert.equal(pickRenderNode(sys), null, 'no DRM class: none');
  node('renderD128', 'vgem');
  assert.equal(pickRenderNode(sys), null, 'vgem is no GPU');
  node('renderD129', 'nvidia', 0);
  assert.equal(pickRenderNode(sys), null, 'NVIDIA without modeset: no GBM');
  modeset('Y');
  assert.equal(pickRenderNode(sys), '/dev/dri/renderD129', 'NVIDIA with modeset=Y');
  node('renderD130', 'amdgpu', 0);
  node('renderD131', 'i915', 0);
  assert.equal(pickRenderNode(sys), '/dev/dri/renderD131', 'no boot GPU: the driver order (i915 first)');
  fs.writeFileSync(path.join(sys, 'class', 'drm', 'renderD130', 'device', 'boot_vga'), '1\n');
  assert.equal(pickRenderNode(sys), '/dev/dri/renderD130', 'the GPU the firmware booted on first');
  modeset('N');
  node('renderD132', 'xe', 1);
  node('card0', 'i915', 1);
  assert.equal(pickRenderNode(sys), '/dev/dri/renderD130', 'the lowest boot node; card* are not render nodes');
  fs.rmSync(path.join(sys, 'class'), { recursive: true, force: true });
  node('renderD200', 'somedrv');
  node('renderD99', 'otherdrv');
  assert.equal(pickRenderNode(sys), '/dev/dri/renderD99', 'unknown drivers: the first node, in numeric order');
  fs.rmSync(sys, { recursive: true, force: true });
}

// GPU recovery (gpu-recovery.ts): a start in software compositing tries the next switches level, once each.
{
  const { gpuSwitches, gpuLevel, nextGpuStep, GPU_LEVELS, readGpuState, writeGpuState, clearGpuCaches, readTextureCheck, writeTextureCheck } = await load('src/main/features/gpu-recovery.ts');
  const names = (l, p = 'linux', wayland = false) => gpuSwitches(p, l, wayland).map(([n, v]) => (v ? `${n}=${v}` : n));
  assert.deepEqual(names(0), ['enable-gpu-rasterization', 'enable-zero-copy', 'ignore-gpu-blocklist'], 'level 0: the usual switches, no feature names Chromium 152 dropped');
  assert.deepEqual(names(0, 'win32'), names(0), 'Windows: the same');
  assert.deepEqual(names(3, 'win32'), names(0, 'win32'), 'Windows never changes level');
  assert.deepEqual(names(1), ['ignore-gpu-blocklist', 'disable-accelerated-video-decode'], 'level 1: no zero-copy, GPU rasterization or hardware decode');
  assert.ok(names(2).includes('disable-gpu-sandbox') && !names(2).some((n) => n.startsWith('use-angle')));
  assert.deepEqual(names(3), ['ignore-gpu-blocklist', 'disable-accelerated-video-decode', 'disable-gpu-sandbox', 'use-angle=vulkan', 'enable-features=Vulkan,VulkanFromANGLE'], 'level 3 on X11: ANGLE on Vulkan');
  assert.deepEqual(names(3, 'linux', true), ['ignore-gpu-blocklist', 'disable-accelerated-video-decode', 'disable-gpu-sandbox', 'use-angle=gles'], 'level 3 on Wayland: ANGLE on GLES, never Vulkan (texture mode)');
  const k = '0.13.2/44.9.0';
  let st = null;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const r = nextGpuStep(st, k, false);
    st = r.state;
    if (!r.relaunch) break;
    seen.push(st.level);
  }
  assert.deepEqual(seen, [1, 2, 3], 'each level tried once, by relaunch');
  assert.equal(st.exhausted, true, 'then given up for this build');
  assert.equal(gpuLevel(st, k), 0, 'given up: the usual switches');
  assert.equal(nextGpuStep(st, k, false).relaunch, false, 'no relaunch loop once given up');
  assert.equal(nextGpuStep(st, '0.13.3/44.9.0', false).state.level, 1, 'a new build tries again');
  assert.deepEqual(nextGpuStep({ key: k, level: 2 }, k, true), { state: { key: k, level: 2 }, relaunch: false }, 'a working level is kept');
  assert.equal(gpuLevel({ key: 'old', level: 3 }, k), 0, 'another build starts at 0');
  assert.equal(gpuLevel({ key: k, level: 99 }, k), GPU_LEVELS - 1, 'clamped');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-gpu-'));
  assert.equal(readGpuState(dir), null);
  assert.equal(writeGpuState(dir, { key: k, level: 2 }), true);
  assert.deepEqual(readGpuState(dir), { key: k, level: 2, exhausted: false });
  assert.equal(writeGpuState(path.join(dir, 'missing'), { key: k, level: 2 }), false, 'a failed write says so (no relaunch then)');
  fs.mkdirSync(path.join(dir, 'GPUCache'));
  fs.mkdirSync(path.join(dir, 'GPUPersistentCache'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  clearGpuCaches(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'GPUCache')) && !fs.existsSync(path.join(dir, 'GPUPersistentCache')) && fs.existsSync(path.join(dir, 'settings.json')), 'only the GPU caches go');
  const tk = '0.13.2/44.9.0/0x1002:0x73bf/Mesa 25.2/dev/dri/renderD128/level 0';
  assert.equal(readTextureCheck(dir, tk), null);
  writeTextureCheck(dir, tk, 'picture check failed 3 times in a row');
  assert.equal(readTextureCheck(dir, tk), 'picture check failed 3 times in a row', 'a texture failure is remembered');
  assert.equal(readTextureCheck(dir, tk.replace('level 0', 'level 1')), null, 'for this key only');
  fs.rmSync(dir, { recursive: true, force: true });
}

const xrandr = `Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384
DP-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     59.95*+ 143.97   119.88    23.98
   1920x1080     60.00    50.00    23.98
   1920x1080i    60.00    50.00
HDMI-1 connected 1920x1080+2560+0 (normal left inverted right x axis y axis) 527mm x 296mm
   1920x1080     60.00 +  50.00*   59.94    24.00    23.98
   1280x720      60.00
HDMI-2 disconnected (normal left inverted right x axis y axis)
`;
const outs = parseXrandr(xrandr);
assert.deepEqual(outs.map((o) => [o.name, o.x, o.y, o.width, o.height, o.rate]), [['DP-1', 0, 0, 2560, 1440, 59.95], ['HDMI-1', 2560, 0, 1920, 1080, 50]]);
assert.deepEqual(outs[0].modes.map((m) => m.rate), [59.95, 143.97, 119.88, 23.98], 'only the current resolution');
assert.deepEqual(outs[1].restore, ['--output', 'HDMI-1', '--mode', '1920x1080', '--rate', '50.00']);
assert.deepEqual(outs[1].modes.find((m) => m.rate === 23.98).args, ['--output', 'HDMI-1', '--mode', '1920x1080', '--rate', '23.98']);
assert.equal(outputAt(outs, { x: 3000, y: 500 }).name, 'HDMI-1');
assert.equal(outputAt(outs, { x: 9000, y: 500 }), null, 'off every output with two outputs');
assert.equal(outputAt(outs.slice(0, 1), { x: 9000, y: 500 }).name, 'DP-1', 'a single output is the fallback');

const kscreen = JSON.stringify({
  outputs: [
    {
      id: 1,
      name: 'DP-2',
      enabled: true,
      connected: true,
      currentModeId: '3',
      scale: 1.5,
      pos: { x: 0, y: 0 },
      modes: [
        { id: '1', name: '3840x2160@60', refreshRate: 60, size: { width: 3840, height: 2160 } },
        { id: '2', name: '3840x2160@24', refreshRate: 23.976, size: { width: 3840, height: 2160 } },
        { id: '3', name: '3840x2160@120', refreshRate: 119.88, size: { width: 3840, height: 2160 } },
        { id: '4', name: '1920x1080@50', refreshRate: 50, size: { width: 1920, height: 1080 } },
      ],
    },
    { id: 2, name: 'HDMI-A-1', enabled: false, connected: true, currentModeId: '1', modes: [] },
  ],
});
const k = parseKscreen(`kscreen.doctor: some log line\n${kscreen}`);
assert.equal(k.length, 1);
assert.deepEqual([k[0].name, k[0].width, k[0].height, k[0].rate], ['DP-2', 2560, 1440, 119.88], 'logical size');
assert.deepEqual(k[0].modes.map((m) => m.rate), [60, 23.976, 119.88]);
assert.deepEqual(k[0].modes[1].args, ['output.DP-2.mode.2']);
assert.deepEqual(k[0].restore, ['output.DP-2.mode.3']);

// Same choice as the Windows script.
assert.equal(pickRate(60, [60, 50, 24], 30), null, 'already a multiple');
assert.equal(pickRate(60, [60, 50, 24], 25), 50);
assert.equal(pickRate(59.95, [59.95, 143.97, 119.88, 23.98], 23.976), 119.88, 'the highest exact multiple');
assert.equal(pickRate(60, [60, 50, 23.98], 23.976), 23.98);
assert.equal(pickRate(60, [60, 50], 23.976), null, 'no matching rate: keep');
assert.equal(pickRate(119.88, [60, 23.976, 119.88], 24000 / 1001), null, '119.88 is 5 x 23.976');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('linux-desktop-check: OK');
