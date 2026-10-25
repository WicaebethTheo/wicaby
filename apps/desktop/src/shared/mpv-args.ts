// "Arguments mpv supplémentaires": an ALLOW-LIST. Only picture, scaling, shader, subtitle,
// sync, deband, dither, interpolation, tone-mapping and audio tweaks get through; anything
// that loads scripts or config, writes files, talks to a pipe or takes over the embedding
// is refused. Every token is --name=value (or --no-name, or a bare --name for a known
// yes/no flag, rewritten to --name=yes), so no option can swallow the next argument
// (Wicaby's own --wid follows the user's arguments).

import type { HwDec } from './contract';

// Exact option names.
const ALLOWED = new Set([
  // picture
  'brightness', 'contrast', 'saturation', 'gamma', 'hue', 'deinterlace',
  'video-aspect-override', 'video-zoom', 'video-pan-x', 'video-pan-y', 'video-align-x', 'video-align-y',
  'video-rotate', 'video-unscaled', 'panscan', 'keepaspect', 'keepaspect-window', 'background-color',
  'target-peak', 'target-prim', 'target-trc', 'target-contrast', 'target-gamut',
  'target-colorspace-hint', 'target-colorspace-hint-mode', 'vd-lavc-film-grain',
  // scaling
  'scale', 'cscale', 'dscale', 'tscale', 'correct-downscaling', 'linear-downscaling', 'linear-upscaling',
  'sigmoid-upscaling', 'scaler-resizes-only',
  // deband, dither
  'deband', 'dither', 'temporal-dither', 'temporal-dither-period', 'error-diffusion',
  // sync, interpolation
  'video-sync', 'video-sync-max-video-change', 'video-sync-max-audio-change', 'video-sync-max-factor',
  'display-fps-override', 'override-display-fps', 'interpolation', 'interpolation-threshold',
  'interpolation-preserve', 'framedrop', 'autosync', 'mc', 'video-latency-hacks',
  // tone mapping
  'inverse-tone-mapping', 'allow-delayed-peak-detect',
  // subtitles
  'blend-subtitles', 'embeddedfonts', 'stretch-image-subs-to-screen', 'stretch-dvd-subs', 'image-subs-video-resolution',
  // audio
  'audio-delay', 'audio-channels', 'audio-samplerate', 'audio-format', 'audio-normalize-downmix',
  'audio-pitch-correction', 'audio-exclusive', 'audio-buffer', 'audio-stream-silence', 'audio-wait-open',
  'gapless-audio', 'volume', 'volume-max', 'replaygain', 'replaygain-preamp', 'replaygain-clip', 'replaygain-fallback',
  // colour management and output format (no file paths)
  'icc-profile-auto', 'icc-intent', 'icc-force-contrast', 'fbo-format', 'd3d11-output-format', 'd3d11-output-csp',
]);

// yes/no flags that may be written bare (--interpolation); they are passed as --name=yes.
const FLAGS = new Set([
  'deband', 'interpolation', 'temporal-dither', 'correct-downscaling', 'linear-downscaling', 'linear-upscaling',
  'sigmoid-upscaling', 'scaler-resizes-only', 'interpolation-preserve', 'keepaspect', 'keepaspect-window',
  'inverse-tone-mapping', 'allow-delayed-peak-detect', 'video-latency-hacks', 'embeddedfonts',
  'stretch-image-subs-to-screen', 'stretch-dvd-subs', 'image-subs-video-resolution', 'audio-exclusive',
  'audio-normalize-downmix', 'audio-pitch-correction', 'replaygain-clip', 'icc-profile-auto',
]);

// Option families, by prefix.
const ALLOWED_PREFIXES = [
  'scale-', 'cscale-', 'dscale-', 'tscale-', 'sigmoid-', 'deband-', 'dither-',
  'tone-mapping', 'hdr-', 'gamut-', 'glsl-shader', 'sub-', 'secondary-sub-',
];

// Refused even if a prefix above would match: scripting, config, input, logs and dumps,
// network fetchers, the control pipe and the embedding.
const DENIED = new Set([
  'scripts', 'load-scripts', 'include', 'log-file', 'config', 'config-dir', 'stream-dump', 'script-opts',
  'wid', 'idle', 'terminal', 'profile', 'use-filedir-conf', 'keep-open', 'force-window', 'sub-fonts-dir',
]);
const DENIED_PREFIXES = ['script', 'input-', 'dump-', 'watch-later-', 'ytdl', 'msg-', 'log-'];

// A UNC or device path (\\server\share, //server, \\?\, \\.\pipe) or any URL.
const UNC_RE = /[\\/]{2}/;
// Never in any value: '?' (the NT prefix \??\UNC\host\share has no doubled separator)
// and control characters (a URL parser drops tab/CR/LF, Win32 stops at NUL).
const BAD_VALUE_RE = /[?\x00-\x1f\x7f]/;

// Options whose value is a file, a directory or a list of them.
const PATH_OPTION_RE = /^(sub-files?|sub-file-paths|glsl-shaders?)(-(append|add|set|pre|remove|del|toggle))?$|^sub-ass-styles$|-(file|files|dir|path|paths)$/;
// Win32 device names, which open a device instead of a file whatever the folder.
const DEVICE_RE = /^(con|prn|aux|nul|conin\$|conout\$|com\d|lpt\d)(\..*)?$/i;

// One path in an option value: an absolute path on a local drive letter (C:\...) or a
// path in mpv's config folder (~~/...). No UNC, NT or device prefix, no "..", no ":" past
// the drive (alternate data streams), no device names.
function isLocalPathElement(p: string): boolean {
  let rest: string;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~~/')) rest = p.slice(3);
  else return false;
  return rest.split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes(':') && !DEVICE_RE.test(s));
}

function isSafeValue(name: string, value: string): boolean {
  if (UNC_RE.test(value) || BAD_VALUE_RE.test(value)) return false;
  // Path lists are ';'-separated on Windows; every element must be a local path.
  if (PATH_OPTION_RE.test(name)) return value.split(';').every(isLocalPathElement);
  return true;
}

export function isAllowedMpvOption(name: string): boolean {
  const n = name.toLowerCase();
  if (DENIED.has(n) || DENIED_PREFIXES.some((p) => n.startsWith(p))) return false;
  return ALLOWED.has(n) || ALLOWED_PREFIXES.some((p) => n.startsWith(p));
}

export function parseMpvArgs(text: unknown): { args: string[]; rejected: string[] } {
  const args: string[] = [];
  const rejected: string[] = [];
  for (const raw of (typeof text === 'string' ? text : '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const token = raw.replace(/"/g, '');
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=(.*))?$/is.exec(token);
    if (!m) {
      rejected.push(raw);
      continue;
    }
    const negated = /^no-/i.test(m[1]);
    const name = (negated ? m[1].slice(3) : m[1]).toLowerCase();
    const value = m[2];
    if (!isAllowedMpvOption(name)) rejected.push(raw);
    else if (negated) {
      // --no-name for a flag; --no-name=x is not a thing.
      if (value === undefined) args.push(`--no-${name}`);
      else rejected.push(raw);
    } else if (value === undefined) {
      // A bare --name could eat the next argument, unless it is a known flag.
      if (FLAGS.has(name)) args.push(`--${name}=yes`);
      else rejected.push(raw);
    } else if (isSafeValue(name, value)) args.push(`--${name}=${value}`);
    else rejected.push(raw);
  }
  return { args, rejected };
}

// Music (music-spec §4.1): the windowless audio player takes only the audio part of the allow-listed arguments
// (parseMpvArgs output): audio-*, volume*, replaygain* and gapless-audio. Video options mean nothing there.
export function audioMpvArgs(args: string[]): string[] {
  return args.filter((a) => /^--(no-)?(audio-|volume|replaygain|gapless-audio)/.test(a));
}

// Shape of an mpv path the user may point Wicaby at: an absolute path on a local drive
// letter (no UNC, device or relative path), no "..", ending in mpv.exe. Existence is
// checked by the main process. Linux: an absolute path, no "." or ".." or empty segment,
// to a file named mpv, outside the kernel's pseudo file systems (/proc/<pid>/root, /dev/fd, ...).
export function isMpvPathShape(p: unknown, platform: string): p is string {
  if (platform !== 'win32')
    return (
      typeof p === 'string' && p.length <= 1024 && !BAD_VALUE_RE.test(p) && /^(\/[^/]+)*\/mpv$/.test(p) && !/^\/(proc|dev|sys)\//.test(p) &&
      !p.slice(1).split('/').some((s) => s === '.' || s === '..' || s.trim() === '')
    );
  if (typeof p !== 'string' || p.length < 10 || p.length > 1024 || BAD_VALUE_RE.test(p)) return false;
  if (!/^[A-Za-z]:[\\/]/.test(p) || UNC_RE.test(p.slice(2))) return false;
  const parts = p.slice(3).split(/[\\/]/);
  if (parts.some((s) => s === '..' || s === '.' || s === '' || s.includes(':') || DEVICE_RE.test(s))) return false;
  return parts[parts.length - 1].toLowerCase() === 'mpv.exe';
}

// True when mpv's version string ("0.41.0", "v0.40.0-12-gabc") is at least 0.<minor>; an
// unparsable version (custom build) is assumed recent.
export function mpvAtLeast(version: string | null, minor: number): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version ?? '');
  return !m || Number(m[1]) > 0 || Number(m[2]) >= minor;
}

// Detached mpv (native Wayland without the render addon): its own window takes the Wicaby window's size and
// maximized state (Wayland ignores a position; --geometry is in physical pixels, mpv divides by the output's scale),
// keeps it from file to file, letterboxes instead of reshaping, and is full screen only when asked.
export function detachedWindowArgs(win: { width: number; height: number; scale: number; maximized: boolean } | null, fullscreen: boolean): string[] {
  return [
    '--keepaspect-window=no',
    '--auto-window-resize=no',
    ...(win ? [`--geometry=${Math.round(win.width * win.scale)}x${Math.round(win.height * win.scale)}`] : []),
    ...(win?.maximized ? ['--window-maximized=yes'] : []),
    ...(fullscreen ? ['--fullscreen=yes'] : []),
  ];
}

// Renderer, decoder, colour and audio-output arguments for this platform. Windows ships its
// own recent mpv (vendor/mpv): its arguments never depend on the version. Elsewhere the
// system mpv may be older, so newer options are dropped below the release that added them.
export function mpvOutputArgs(p: { hwdec: HwDec; useMpvConfig: boolean; audioExclusive: boolean; smoothMotion?: boolean }, platform: string, version: string | null, embedded = true): string[] {
  const win = platform === 'win32';
  const has = (minor: number) => win || mpvAtLeast(version, minor);
  const hwdec = win
    ? // d3d11va decodes zero-copy into the d3d11 renderer on every vendor; nvdec proper needs an
      // OpenGL/Vulkan context, so only its copy-back variant remains as a fallback. Every ffmpeg hwaccel
      // keeps the Dolby Vision RPU (checked on DV P5/P8 samples), so DV needs no copy-back mode.
      // A failing decoder falls back to software, so every codec ffmpeg knows still plays.
      p.hwdec === 'nvdec' ? 'd3d11va,nvdec-copy,auto-safe' : p.hwdec === 'd3d11va' ? 'd3d11va,auto-safe' : p.hwdec === 'vaapi' || p.hwdec === 'vulkan' ? 'auto-safe' : p.hwdec
    : // Linux: vaapi, nvdec and vulkan all interop with the Vulkan/OpenGL renderer; d3d11va does not exist.
      p.hwdec === 'no' || p.hwdec === 'auto-safe' ? p.hwdec : p.hwdec === 'd3d11va' ? 'auto-safe' : `${p.hwdec},auto-safe`;
  return [
    '--vo=gpu-next',
    // Linux: --wid is an X11 window (X11 or XWayland, see index.ts), so only X11 contexts can embed; mpv's own
    // window (native Wayland) picks its context.
    ...(win ? ['--gpu-api=d3d11'] : ['--gpu-api=auto', ...(embedded ? ['--gpu-context=x11vk,x11egl'] : [])]),
    `--hwdec=${hwdec}`,
    // auto: PQ/BT.2020 swapchain at the display's peak when Windows HDR is on, SDR otherwise.
    // "no" would tone-map to SDR even on an HDR desktop (dim, flat). The passthrough setting
    // switches the mode to "source" once mpv has seen an HDR output (see onTargetGamma).
    '--target-colorspace-hint=auto',
    ...(has(41) ? ['--target-colorspace-hint-mode=target'] : []),
    // HDR to SDR: spline with per-scene peak detection, as mpv's high-quality profile.
    ...(p.useMpvConfig
      ? []
      : [
          '--tone-mapping=spline',
          '--hdr-compute-peak=yes',
          ...(has(37) ? ['--hdr-peak-percentile=99.995'] : []),
          ...(has(36) ? ['--hdr-contrast-recovery=0.30'] : []),
          '--gamut-mapping-mode=perceptual',
        ]),
    // Smooth playback: with the default video-sync=audio, the small drift between the sound card's and the display's
    // clocks makes mpv drop a frame every minute or so; display-resample times frames to the display and resamples
    // the audio instead (mpv falls back to audio sync by itself for bitstreams). mpv.conf, read after, still wins.
    ...(p.smoothMotion ? ['--video-sync=display-resample'] : []),
    win ? '--ao=wasapi' : '--ao=pipewire,pulse,alsa',
    `--audio-exclusive=${p.audioExclusive ? 'yes' : 'no'}`,
    // B06: DVR recordings, DVD rips and 1080i TS direct-play interlaced; auto only filters interlaced frames.
    // Gated one release above the one believed to add it: an unknown choice would stop mpv from starting.
    ...(has(39) ? ['--deinterlace=auto'] : []),
    // P06: Wicaby runs the one SMTC session (OsdWindow.svelte, navigator.mediaSession); mpv's own would fight it.
    ...(win ? ['--media-controls=no'] : []),
  ];
}
