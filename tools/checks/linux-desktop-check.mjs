// Self-check for the Linux desktop integration, with win32 and linux cases side by side:
// - media keys: global shortcuts only for mpv in WASAPI exclusive mode on Windows, never on Linux (MPRIS);
// - XDG autostart entry: Exec quoting, $APPIMAGE, and the desktop's "disabled" markers;
// - refresh-rate matching: session detection, xrandr and kscreen-doctor parsing, rate choice.
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
const { linuxDisplayTool, parseXrandr, parseKscreen, outputAt, pickRate, ozonePlatform, nativeWayland, mpvRenderMode } = await load('src/main/features/display-mode-linux.ts');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), 'xrandr');
assert.equal(linuxDisplayTool({ DISPLAY: ':0' }), 'xrandr');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }), 'kscreen-doctor');
assert.equal(linuxDisplayTool({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), null, 'GNOME on Wayland: no tool');
assert.equal(linuxDisplayTool({ XDG_SESSION_TYPE: 'tty' }), null);

// ---- Ozone backend (WICABY_OZONE) ----
const kde = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
assert.equal(ozonePlatform(kde), 'wayland', 'Wayland session: native Wayland even with XWayland (#14)');
assert.equal(ozonePlatform({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }), 'wayland', 'no X server: native Wayland');
assert.equal(ozonePlatform({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'x11', 'X11 session: X11');
assert.equal(ozonePlatform({ DISPLAY: ':0' }), 'x11');
assert.equal(ozonePlatform({}), 'x11');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: ' Wayland ' }), 'wayland');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'auto' }), 'auto');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'bogus' }), 'wayland', 'unknown value: the default');
assert.equal(ozonePlatform({ ...kde, WICABY_OZONE: 'x11' }), 'x11');
assert.equal(nativeWayland(kde, 'x11'), false);
assert.equal(nativeWayland(kde, 'wayland'), true);
assert.equal(nativeWayland(kde, 'auto'), true);
assert.equal(nativeWayland({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, 'auto'), false);

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
