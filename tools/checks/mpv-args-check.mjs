// Self-check for the mpv argument allow-list and the mpv path rules (src/shared/mpv-args.ts),
// plus source guards for the IPC hardening that cannot be imported without Electron.
// Run: node tools/checks/mpv-args-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { audioMpvArgs, isAllowedMpvOption, isMpvPathShape, mpvAtLeast, mpvOutputArgs, parseMpvArgs } from '../../apps/desktop/src/shared/mpv-args.ts';

const ok = (text) => assert.deepEqual(parseMpvArgs(text).rejected, [], `should accept: ${text}`);
const no = (text) => assert.deepEqual(parseMpvArgs(text).args, [], `should reject: ${text}`);

// Allowed families.
for (const a of [
  '--deband=yes', '--deband-iterations=2', '--no-deband', '--scale=ewa_lanczossharp', '--cscale-antiring=0.5',
  '--glsl-shaders=~~/shaders/FSRCNNX.glsl', '--glsl-shaders-append="C:/mpv/shaders/a b.glsl"',
  '--sub-font="Segoe UI"', '--sub-file=C:\\subs\\film.srt', '--sub-ass-override=force', '--secondary-sub-pos=10',
  '--video-sync=display-resample', '--interpolation=yes', '--tscale=oversample', '--dither-depth=auto', '--temporal-dither=yes',
  '--tone-mapping=bt.2446a', '--hdr-compute-peak=no', '--gamut-mapping-mode=clip', '--target-peak=400',
  '--brightness=5', '--saturation=-3', '--audio-delay=0.1', '--audio-channels=stereo', '--volume=80', '--replaygain=track',
]) ok(a);
assert.deepEqual(parseMpvArgs('--deband=yes  --scale=spline36').args, ['--deband=yes', '--scale=spline36']);
assert.deepEqual(parseMpvArgs('--sub-font="Segoe UI"').args, ['--sub-font=Segoe UI']);
// Known yes/no flags may be bare; they are passed as --name=yes so nothing eats the next argument.
assert.deepEqual(parseMpvArgs('--interpolation --deband --no-deband').args, ['--interpolation=yes', '--deband=yes', '--no-deband']);
for (const a of [
  '--glsl-shader-opts=L=1', '--glsl-shaders=C:\\s\\a.glsl;~~/shaders/b.glsl', '--sub-files=C:\\a.srt;D:/b.srt',
  '--sub-ass-styles=~~/styles.ass', '--icc-profile-auto=yes', '--sub-file=C:\\films\\a..b.srt',
]) ok(a);

// Explicitly refused: scripting, config, input, logs, dumps, fetchers, embedding.
for (const a of [
  '--script=C:/x.lua', '--scripts=a.lua', '--script-opts=a=b', '--scripts-append=x.js', '--load-scripts=yes',
  '--include=C:/evil.conf', '--input-ipc-server=\\\\.\\pipe\\x', '--input-conf=C:/in.conf', '--input-commands=quit',
  '--log-file=C:/Windows/x', '--config-dir=C:/x', '--config=yes', '--dump-stats=C:/x', '--stream-dump=C:/out',
  '--watch-later-directory=C:/x', '--write-filename-in-watch-later-config', '--ytdl=yes', '--ytdl-path=C:/x.exe',
  '--ytdl-raw-options=exec=calc', '--wid=0', '--idle=no', '--terminal=no', '--msg-level=all=v', '--profile=gpu-hq',
  '--use-filedir-conf=yes', '--no-wid', '--keep-open=yes', '--force-window=no', '--sub-fonts-dir=C:/x',
  // Not allow-listed at all.
  '--vf=lavfi=[movie=C\\:/x]', '--af=lavfi=[amovie=x]', '--o=C:/out.mkv', '--screenshot-directory=C:/x', '--external-file=C:/x',
  '--audio-file=C:/x.mka', '--icc-profile=C:/x.icc', '--hwdec=no', '--demuxer-lavf-o=protocol_whitelist=file',
  // Shape: no bare option that could eat the next argument, no single dash, no positional.
  '--sub-file', '-deband=yes', 'C:/movie.mkv', '--no-deband=yes',
  // UNC, device paths and URLs in any value.
  '--sub-file=\\\\server\\share\\x.srt', '--sub-file=//server/share/x.srt', '--glsl-shaders=\\\\?\\UNC\\srv\\x.glsl',
  '--glsl-shaders=https://evil/x.glsl', '--sub-font=a\\\\b',
  // NT namespace prefix (no doubled separator) and any '?'.
  '--sub-file=\\??\\UNC\\h\\s\\x.srt', '--glsl-shaders=\\??\\UNC\\attacker\\s\\x.glsl', '--sub-ass-styles=\\??\\UNC\\h\\s\\a.ass',
  '--sub-files=C:\\a.srt;\\??\\UNC\\h\\s\\b.srt', '--sub-file=/??/UNC/h/s/x.srt', '--sub-font=a?b', '--sub-file=\\GLOBAL??\\UNC\\h\\s\\x',
  // Path options: drive-absolute or ~~/ only, no relative, root-relative, drive-relative, "..", ADS or device name.
  '--sub-file=x.srt', '--sub-file=\\Device\\Mup\\h\\s\\x.srt', '--sub-file=C:x.srt', '--sub-file=C:\\a\\..\\..\\x.srt',
  '--sub-file=C:\\a\\x.srt:ads', '--sub-file=C:\\a\\CON', '--sub-files=C:\\a.srt;', '--glsl-shaders=~/x.glsl', '--sub-file-paths=subs',
  // Control characters.
  '--sub-font="a\tb"', '--sub-file="C:\\a\n.srt"', '--sub-file=C:\\a\x00.srt', '--sub-font=a\x7f',
  // A bare option that is not a flag.
  '--scale', '--glsl-shaders-clr',
]) no(a);
assert.ok(!isAllowedMpvOption('SCRIPT'));
assert.equal(parseMpvArgs(undefined).args.length, 0);

// mpv path shape: absolute local drive path to mpv.exe only.
for (const p of ['C:\\mpv\\mpv.exe', 'D:/Tools/mpv/MPV.EXE', 'C:\\mpv.exe']) assert.ok(isMpvPathShape(p, 'win32'), p);
for (const p of [
  '', 'mpv.exe', '.\\mpv.exe', '\\mpv\\mpv.exe', '\\\\server\\share\\mpv.exe', '//server/share/mpv.exe', '\\\\?\\C:\\mpv\\mpv.exe',
  '\\\\.\\C:\\mpv.exe', 'C:mpv.exe', 'C:\\x\\..\\mpv.exe', 'C:\\x\\calc.exe', 'C:\\x\\mpv.exe:ads', 'C:\\x\\mpv.exe.lnk',
  'C:\\\\srv\\mpv.exe', 'C:\\x\\mpv.com', 'C:\\x\\mpv.exe\0', 'C:\\x?\\mpv.exe', 'C:\\CON\\mpv.exe', 'C:\\x\t\\mpv.exe', null, 42,
]) assert.ok(!isMpvPathShape(p, 'win32'), String(p));
// Linux: an absolute path to a file named mpv; no relative, dot or empty segment, no control character.
for (const p of ['/usr/bin/mpv', '/usr/local/bin/mpv', '/app/bin/mpv', '/opt/Wicaby/resources/mpv/mpv', '/home/me/my mpv/mpv', '/home/proc/mpv', '/devtools/mpv'])
  assert.ok(isMpvPathShape(p, 'linux'), p);
for (const p of [
  '', 'mpv', './mpv', 'bin/mpv', '/usr/bin/mpv.exe', '/usr/bin/mpv2', '/usr/bin/MPV', '/usr/bin/../bin/mpv', '/usr/./bin/mpv',
  '//usr/bin/mpv', '/usr//bin/mpv', '/usr/bin/mpv/', '/usr/bin/x\n/mpv', '/usr/bin/mpv\0', '/x?/mpv', 'C:\\mpv\\mpv.exe', 'C:/mpv/mpv', null, 42,
  // Kernel pseudo file systems (another process's root or cwd, descriptors, devices, shared memory) and blank segments.
  '/proc/self/root/usr/bin/mpv', '/proc/1/cwd/mpv', '/dev/mpv', '/dev/fd/3/mpv', '/dev/shm/mpv', '/sys/mpv', '/ /mpv', '/usr/  /mpv',
]) assert.ok(!isMpvPathShape(p, 'linux'), String(p));
// And the reverse: a Linux path is not a Windows one.
assert.ok(!isMpvPathShape('/usr/bin/mpv', 'win32'));

// Version gate: "0.41.0", "v0.40.0-12-gabc"; unparsable (custom build) counts as recent.
assert.ok(mpvAtLeast('0.41.0', 41) && mpvAtLeast('v0.41.0-1122-gaccb7b282', 41) && mpvAtLeast('1.0.0', 41) && mpvAtLeast(null, 41) && mpvAtLeast('git-abc', 41));
assert.ok(!mpvAtLeast('0.40.0', 41) && !mpvAtLeast('v0.36.0', 37) && !mpvAtLeast('0.9.1', 37));

// Platform output arguments. Windows: exactly the arguments Wicaby always passed, whatever the version.
const out = (o, platform, version = null) => mpvOutputArgs({ hwdec: 'auto-safe', useMpvConfig: false, audioExclusive: false, ...o }, platform, version);
const WIN = [
  '--vo=gpu-next', '--gpu-api=d3d11', '--hwdec=auto-safe', '--target-colorspace-hint=auto', '--target-colorspace-hint-mode=target',
  '--tone-mapping=spline', '--hdr-compute-peak=yes', '--hdr-peak-percentile=99.995', '--hdr-contrast-recovery=0.30', '--gamut-mapping-mode=perceptual',
  '--ao=wasapi', '--audio-exclusive=no', '--deinterlace=auto', '--media-controls=no',
];
assert.deepEqual(out({}, 'win32'), WIN);
assert.deepEqual(out({}, 'win32', '0.35.0'), WIN, 'Windows never gates by version');
// Smooth Playback (on by default in the settings): display-resample, just before the audio output.
const smooth = out({ smoothMotion: true }, 'win32');
assert.equal(smooth[smooth.indexOf('--ao=wasapi') - 1], '--video-sync=display-resample');
assert.ok(!out({ smoothMotion: false }, 'linux').some((a) => a.startsWith('--video-sync')));
const hw = (hwdec, platform) => out({ hwdec }, platform).find((a) => a.startsWith('--hwdec='));
assert.equal(hw('nvdec', 'win32'), '--hwdec=d3d11va,nvdec-copy,auto-safe');
assert.equal(hw('d3d11va', 'win32'), '--hwdec=d3d11va,auto-safe');
assert.equal(hw('no', 'win32'), '--hwdec=no');
assert.equal(hw('vaapi', 'win32'), '--hwdec=auto-safe', 'imported Linux value');
assert.equal(hw('vulkan', 'win32'), '--hwdec=auto-safe', 'imported Linux value');
assert.deepEqual(out({ useMpvConfig: true, audioExclusive: true }, 'win32'), [
  '--vo=gpu-next', '--gpu-api=d3d11', '--hwdec=auto-safe', '--target-colorspace-hint=auto', '--target-colorspace-hint-mode=target', '--ao=wasapi', '--audio-exclusive=yes',
  '--deinterlace=auto', '--media-controls=no',
]);
// Linux: X11 contexts (embedded --wid), PipeWire then PulseAudio then ALSA, Linux decoders.
assert.deepEqual(out({}, 'linux', '0.41.0'), [
  '--vo=gpu-next', '--gpu-api=auto', '--gpu-context=x11vk,x11egl', '--hwdec=auto-safe', '--target-colorspace-hint=auto', '--target-colorspace-hint-mode=target',
  '--tone-mapping=spline', '--hdr-compute-peak=yes', '--hdr-peak-percentile=99.995', '--hdr-contrast-recovery=0.30', '--gamut-mapping-mode=perceptual',
  '--ao=pipewire,pulse,alsa', '--audio-exclusive=no', '--deinterlace=auto',
]);
// mpv's own window (native Wayland, #14): no X11 context forced.
assert.ok(!mpvOutputArgs({ hwdec: 'auto-safe', useMpvConfig: false, audioExclusive: false }, 'linux', '0.41.0', false).some((a) => a.startsWith('--gpu-context')));
assert.equal(hw('vaapi', 'linux'), '--hwdec=vaapi,auto-safe');
assert.equal(hw('nvdec', 'linux'), '--hwdec=nvdec,auto-safe');
assert.equal(hw('vulkan', 'linux'), '--hwdec=vulkan,auto-safe');
assert.equal(hw('d3d11va', 'linux'), '--hwdec=auto-safe', 'imported Windows value');
assert.equal(hw('no', 'linux'), '--hwdec=no');
assert.ok(out({ audioExclusive: true }, 'linux').includes('--audio-exclusive=yes'));
// Version gates: hint mode 0.41, peak percentile 0.37, contrast recovery 0.36.
const l40 = out({}, 'linux', '0.40.0');
assert.ok(!l40.includes('--target-colorspace-hint-mode=target') && l40.includes('--hdr-peak-percentile=99.995') && l40.includes('--hdr-contrast-recovery=0.30'));
const l36 = out({}, 'linux', 'v0.36.0');
assert.ok(!l36.includes('--hdr-peak-percentile=99.995') && l36.includes('--hdr-contrast-recovery=0.30'));
assert.ok(!out({}, 'linux', '0.35.0').some((a) => a.startsWith('--hdr-contrast-recovery')));
assert.ok(out({}, 'linux', null).includes('--target-colorspace-hint-mode=target'), 'unknown version: assumed recent');
// B06 deinterlace=auto from 0.39 on Linux (always on Windows); P06 SMTC off on Windows only (Linux has no such option).
assert.ok(!out({}, 'linux', '0.38.0').includes('--deinterlace=auto') && out({}, 'linux', '0.39.0').includes('--deinterlace=auto'));
assert.ok(!out({}, 'linux', null).includes('--media-controls=no'));
// Every generated argument is --name=value, so none can swallow the next.
for (const platform of ['win32', 'linux']) for (const a of out({}, platform, '0.37.0')) assert.match(a, /^--[a-z0-9-]+=\S+$/, a);

// Source guards for main-process hardening (these modules need Electron to load).
const main = path.join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src', 'main');
const ipc = fs.readFileSync(path.join(main, 'ipc.ts'), 'utf8');
const index = fs.readFileSync(path.join(main, 'index.ts'), 'utf8');
assert.match(ipc, /settings\.update\(withoutMpvOverrides\(patch/, 'settings:update strips mpvPath/mpvArgs');
assert.match(ipc, /settings\.replace\(withoutMpvOverrides\(doc/, 'settings import strips mpvPath/mpvArgs');
assert.match(ipc, /isSafeMpvPath\(file\)/, 'pick-mpv validates the chosen file');
assert.match(ipc, /isSafeApiPath\(path\)/, 'api:request validates its path');
assert.match(ipc, /isSafeManagementUrl\(managementUrl\)/, 'vpn managementUrl must be https or loopback');
assert.match(index, /app\.isPackaged \? undefined : process\.env\.WICABY_DEV_URL/, 'WICABY_DEV_URL ignored when packaged');
assert.match(index, /if \(validId\(args\.ItemId\)\)/, 'DisplayContent ItemId validated');

// The api path rule itself, evaluated from the source so it cannot drift.
const apiRule = /export function isSafeApiPath\(path: unknown\): path is string \{\s*return (.*);\s*\}/.exec(ipc);
assert.ok(apiRule, 'isSafeApiPath found');
const isString = (v, max = 2048) => typeof v === 'string' && v.length <= max;
const isSafeApiPath = new Function('isString', 'path', `return ${apiRule[1]};`).bind(null, isString);
for (const p of ['/Users/abc/Items', '/Items/1/Images/Primary/0', '/System/Logs/embyserver.txt', '/Plugins/x/1.0..2', '/Packages/Installed/a..b%2Fc'])
  assert.ok(isSafeApiPath(p), p);
for (const p of [
  '/Items/../System', '/Items/..', '/Items/./x', '/Items/%2e%2e/x', '/Items/%2E./x', '/Items\\x', '/Items?x=1', '/Items#x', '//evil/x', 'Items',
  '/x/http://y',
  // The URL parser strips tab/CR/LF before resolving dot segments: /Items/.\t./ is "..".
  '/Items/.\t./.\t./web/index.html', '/Items/.\n./x', '/Items/.\r./x', '/Items/ x', '/Items/\x00', '/Items/\x7f', '/Items/é', '/Items/\u2025',
]) assert.ok(!isSafeApiPath(p), JSON.stringify(p));
// What the parser makes of each accepted path never leaves the base path.
for (const p of ['/Users/abc/Items', '/Plugins/x/1.0..2']) assert.ok(new URL(`http://srv:8096/emby${p}`).pathname.startsWith('/emby/'), p);

// Settings import keeps this machine's mpv even when the file has no playback section,
// and a settings patch can only clear the path.
const omo = /function withoutMpvOverrides\(doc: Record<string, unknown>, current: Settings\['playback'\] \| null\): Record<string, unknown> \{([\s\S]*?)\n\}/.exec(ipc);
assert.ok(omo, 'withoutMpvOverrides found');
const withoutMpvOverrides = new Function('doc', 'current', omo[1].replace(/ as Record<string, unknown>/g, '').replace(/: Record<string, unknown>/g, ''));
const here = { mpvPath: 'C:\\mpv\\mpv.exe', mpvArgs: '--deband=yes', volumeBoost: false };
for (const doc of [{ wicabySettings: 1 }, { playback: [] }, { playback: 'x' }, { playback: { mpvPath: 'C:\\evil\\mpv.exe', mpvArgs: '--script=x', volumeBoost: true } }]) {
  const out = withoutMpvOverrides(doc, here);
  assert.equal(out.playback.mpvPath, here.mpvPath, JSON.stringify(doc));
  assert.equal(out.playback.mpvArgs, here.mpvArgs, JSON.stringify(doc));
}
assert.equal(withoutMpvOverrides({ playback: { mpvPath: 'C:\\evil\\mpv.exe' } }, null).playback.mpvPath, undefined);
assert.equal(withoutMpvOverrides({ playback: { mpvPath: '' } }, null).playback.mpvPath, '');
assert.deepEqual(withoutMpvOverrides({ ui: { zoom: 100 } }, null), { ui: { zoom: 100 } });

// Management URL rule: https, or http to loopback only.
const msu = /export function isSafeManagementUrl\(v: unknown\): v is string \{([\s\S]*?)\n\}/.exec(ipc);
assert.ok(msu, 'isSafeManagementUrl found');
const isSafeManagementUrl = new Function('isString', 'v', msu[1].replace('let u: URL;', 'let u;')).bind(null, isString);
for (const u of ['https://hs.example.com', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.ok(isSafeManagementUrl(u), u);
for (const u of ['http://hs.example.com', 'http://192.168.50.10', 'ftp://x', 'file:///C:/x', 'https://a b', 42]) assert.ok(!isSafeManagementUrl(u), String(u));

// Sources that must stay wired: packaged builds drop the dev switches, the stored mesh
// control URL is re-validated before the helper starts, mpv candidates are each validated,
// and stored mpv paths are only shape-checked (existence is checked where mpv runs).
assert.match(index, /if \(app\.isPackaged\) \{\s*delete process\.env\.WICABY_DEV_URL;\s*delete process\.env\.WICABY_DEVTOOLS;/, 'dev switches dropped when packaged');
assert.match(index, /dropUnsafeMeshControlUrl\(path\.join\(userData, 'mesh', 'wicaby\.json'\)\);\s*const vpn = new VpnService/, 'mesh control URL re-validated before the mesh starts');
assert.match(index, /candidates\.find\(\(c\) => isSafeMpvPath\(c\)\)/, 'every mpv candidate validated');
const settingsSrc = fs.readFileSync(path.join(main, 'core', 'settings.ts'), 'utf8');
assert.match(settingsSrc, /s\.playback\.mpvPath = isMpvPathShape\(s\.playback\.mpvPath, process\.platform\)/, 'settings keep an unmounted mpv path');
assert.match(settingsSrc, /if \(!isMpvPathShape\(p, process\.platform\)\) return false;/, 'isSafeMpvPath checks the shape for this platform');
assert.match(index, /const candidates = mpvCandidates\(configured, resourcesPath, appRoot\);/, 'mpv candidates come from mpv-controller.ts');

// mpv-controller.ts (candidates, IPC endpoint): bundled with an Electron stub, run for both platforms.
{
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-mpvctl-'));
  try {
    const outfile = path.join(tmp, 'mpv-controller.mjs');
    await build({
      entryPoints: [path.join(main, 'playback', 'mpv-controller.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'error',
      plugins: [{ name: 'electron-stub', setup: (b) => {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = { getPath: () => "", getLocale: () => "en", on() {} };' }));
      } }],
    });
    const { mpvCandidates, mpvIpcPath } = await import(pathToFileURL(outfile).href);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/opt/mpv/bin:relative/bin::/usr/bin';
      assert.deepEqual(mpvCandidates('/home/me/mpv', '/opt/Wicaby/resources', '/opt/Wicaby/resources/app.asar', 'linux'), [
        '/home/me/mpv', '/opt/Wicaby/resources/mpv/mpv', '/opt/Wicaby/vendor/mpv/mpv',
        '/opt/mpv/bin/mpv', '/usr/bin/mpv', '/usr/bin/mpv', '/usr/local/bin/mpv', '/app/bin/mpv',
      ], 'linux mpv candidates: setting, resources, vendor, absolute PATH entries, then /usr/bin, /usr/local/bin, /app/bin');
      if (process.platform === 'win32') {
        process.env.PATH = 'C:\\Tools;D:\\mpv';
        const win = mpvCandidates('', 'C:\\W\\resources', 'C:\\W\\resources\\app.asar', 'win32');
        assert.deepEqual(win.slice(0, 5), ['', 'C:\\W\\resources\\mpv\\mpv.exe', 'C:\\W\\vendor\\mpv\\mpv.exe', 'C:\\Tools\\mpv.exe', 'D:\\mpv\\mpv.exe']);
        assert.equal(win[win.length - 1], 'C:\\Program Files\\mpv\\mpv.exe');
      }
    } finally {
      process.env.PATH = savedPath;
    }
    assert.deepEqual(mpvIpcPath('abc', 'win32'), { path: '\\\\.\\pipe\\wicaby-mpv-abc' }, 'Windows named pipe unchanged');
    // Linux without a private XDG_RUNTIME_DIR (none here): a fresh 0700 folder holds the socket.
    const savedRun = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const sock = mpvIpcPath('abc', 'linux');
      assert.ok(sock.dir && fs.statSync(sock.dir).isDirectory() && sock.path.endsWith('/wicaby-mpv-abc.sock') && sock.path.startsWith(sock.dir), JSON.stringify(sock));
      if (process.platform !== 'win32') assert.equal(fs.statSync(sock.dir).mode & 0o777, 0o700);
      fs.rmSync(sock.dir, { recursive: true, force: true });
    } finally {
      if (savedRun !== undefined) process.env.XDG_RUNTIME_DIR = savedRun;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const ctlSrc = fs.readFileSync(path.join(main, 'playback', 'mpv-controller.ts'), 'utf8');
assert.match(ctlSrc, /const ipc = mpvIpcPath\(randomUUID\(\)\);/, 'mpv IPC endpoint per platform');
assert.match(ctlSrc, /const cleanup = \(\) => process\.platform !== 'win32' && fs\.rm\(ipc\.dir \?\? pipeName/, 'unix socket removed');
assert.match(ctlSrc, /on\('exit',[^]*?cleanup\(\);[^]*?on\('error',[^]*?cleanup\(\);/, 'unix socket folder removed on exit and on a failed spawn');
assert.match(ctlSrc, /const env = \{ \.\.\.withoutAppDirPaths\(process\.env\), MPV_HRT: process\.env\.MPV_HRT \?\? 'always' \};\s*this\.proc = spawn\(this\.exe, full, \{[^}]* env \}\);/, 'mpv spawned with one lifetime timer-resolution request (MPV_HRT=always), still overridable from the environment');
assert.match(ctlSrc, /let key = '';\s*if \(process\.platform !== 'win32'\)/, 'mpv version cached on Unix only');
// hwdec: only the values this platform's picker offers survive sanitize (the Windows list is unchanged).
assert.match(settingsSrc, /process\.platform === 'win32' \? \(\['auto-safe', 'd3d11va', 'nvdec', 'no'\] as const\) : \(\['auto-safe', 'nvdec', 'vaapi', 'vulkan', 'no'\] as const\)/, 'hwdec per platform');

// Live TV profile (livetv-spec-final.md §8.9): file-local options on loadfile for live streams only,
// so the VOD defaults stay exactly as they are. live-session.ts has no Electron import; its own imports
// have no extension (bundler style), resolved here for that folder.
{
  const { registerHooks } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const srcUrl = pathToFileURL(path.join(main, '..')).href + '/';
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      return next(specifier, context);
    },
  });
}
const { LIVE_MPV_OPTIONS } = await import(new URL('../../apps/desktop/src/main/livetv/live-session.ts', import.meta.url).href);
const liveOpts = Object.fromEntries(LIVE_MPV_OPTIONS);
assert.deepEqual(liveOpts, {
  deinterlace: 'auto',
  'demuxer-lavf-probesize': '1000000',
  'demuxer-lavf-analyzeduration': '1',
  'cache-pause-initial': 'no',
  'hls-bitrate': 'max',
}, 'live mpv profile');
// Joined as one "k=v,k=v" loadfile argument: nothing that would split or quote it.
for (const [k, v] of LIVE_MPV_OPTIONS) assert.ok(/^[a-z][a-z0-9-]*$/.test(k) && /^[A-Za-z0-9.]+$/.test(v), `${k}=${v}`);
const mpvPlayerSrc = fs.readFileSync(path.join(main, 'playback', 'mpv-player.ts'), 'utf8');
assert.match(mpvPlayerSrc, /\.\.\.\(params\.live \? LIVE_MPV_OPTIONS\.map\(/, 'live options only for params.live');
assert.match(mpvPlayerSrc, /ctl\.command\('loadfile', params\.url, 'replace', -1, options\.join\(','\)\)/, 'live options are file-local (loadfile options)');
// Timeshift (§8.8, D-7): also file-local, live only, every value %n%-quoted (the cache dir is a path).
assert.match(mpvPlayerSrc, /\.\.\.\(params\.live \? \(params\.timeshift \?\? \[\]\)\.map\(\(\[k, v\]\) => `\$\{k\}=%\$\{Buffer\.byteLength\(v\)\}%\$\{v\}`\)/, 'timeshift options are live-only and quoted');
// The process-wide arguments (VOD defaults) carry none of them and keep their cache values.
const globalArgs = /const args = \[([\s\S]*?)\n {4}\];/.exec(mpvPlayerSrc)?.[1];
assert.ok(globalArgs, 'mpv args list found');
for (const k of Object.keys(liveOpts)) assert.ok(!globalArgs.includes(`--${k}`), `--${k} must not be a global mpv argument`);
for (const a of ["'--cache=yes'", "'--demuxer-max-bytes=512MiB'", "'--demuxer-max-back-bytes=128MiB'", "'--cache-pause-wait=3'", "'--network-timeout=20'"])
  assert.ok(globalArgs.includes(a), `VOD default ${a} unchanged`);
// The playback service and its sibling modules (play-queue.ts, session-reporter.ts, ...).
const playbackSrc = fs
  .readdirSync(path.join(main, 'playback'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => fs.readFileSync(path.join(main, 'playback', f), 'utf8'))
  .join('\n');
const livePlayerSrc = fs.readFileSync(path.join(main, 'livetv', 'live-player.ts'), 'utf8');
assert.equal(playbackSrc.match(/\blive: true,/g), null, 'the VOD loads never set live: true');
assert.equal(livePlayerSrc.match(/\blive: true,/g)?.length, 1, 'only the live load sets live: true');

// Picture-in-guide (§8.7, A16): keepaspect=yes and subtitles hidden while open; closing restores both
// (sub-visibility back on, the user's aspect mode re-applied), and setAspect waits while it is open.
const guideSrc = /async setGuideOverlay\(open: boolean\)[\s\S]*?\n  \}\n/.exec(mpvPlayerSrc)?.[0] ?? '';
assert.match(guideSrc, /set\('sub-visibility', !open\)/, 'guide overlay hides subtitles and restores them');
assert.match(guideSrc, /if \(open\) await set\('keepaspect', true\)/, 'guide overlay forces keepaspect=yes');
assert.match(guideSrc, /if \(!open\) this\.setAspect\(this\.aspect\)/, 'guide overlay close restores the aspect mode');
assert.match(mpvPlayerSrc, /this\.aspect = a;\s*if \(this\.guide\) return;/, 'aspect changes wait for the guide overlay to close');

// Music (music-spec MU-02 AC8): the windowless audio player keeps only the audio subset of the user's arguments.
assert.deepEqual(
  audioMpvArgs(parseMpvArgs('--deband=yes --audio-channels=stereo --volume-max=130 --replaygain=track --replaygain-preamp=2 --no-gapless-audio --scale=spline36 --audio-exclusive --sub-font=Arial').args),
  ['--audio-channels=stereo', '--volume-max=130', '--replaygain=track', '--replaygain-preamp=2', '--no-gapless-audio', '--audio-exclusive=yes'],
);
assert.deepEqual(audioMpvArgs(['--video-sync=audio', '--hdr-compute-peak=no']), []);

console.log('mpv-args-check: ok');
