import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DesktopPalette, DesktopThemeState } from '../../shared/contract';
import { logger } from '../core/log';

// The 'hyprland' theme (Linux): the app's tokens from the Omarchy theme's colors.toml, else Graphite with
// Hyprland's active border colour as the accent. Omarchy's `theme set` swaps current/theme and rewrites
// current/theme.name, so watching current/ is enough to follow it live.

const log = logger.scope('desktop-theme');

type Rgb = [number, number, number];

// Graphite's tokens (packages/tokens/tokens.json), the base when only the accent comes from Hyprland and the
// fallback for a named colour colors.toml leaves out.
const GRAPHITE: Record<string, string> = {
  '--bg': '#0b0b0d',
  '--bg-elevated': '#151517',
  '--bg-elevated-2': '#1c1c1f',
  '--fill-1': 'rgb(255 255 255 / 0.04)',
  '--fill-2': 'rgb(255 255 255 / 0.07)',
  '--fill-3': 'rgb(255 255 255 / 0.11)',
  '--fill-4': 'rgb(255 255 255 / 0.16)',
  '--separator': 'rgb(255 255 255 / 0.08)',
  '--hairline': 'rgb(255 255 255 / 0.12)',
  '--material-thin': 'rgb(28 28 31 / 0.55)',
  '--material': 'rgb(24 24 27 / 0.72)',
  '--material-thick': 'rgb(20 20 23 / 0.86)',
  '--scrim': 'rgb(0 0 0 / 0.5)',
  '--label': '#f5f5f7',
  '--label-2': 'rgb(235 235 245 / 0.62)',
  '--label-3': 'rgb(235 235 245 / 0.34)',
  '--label-4': 'rgb(235 235 245 / 0.18)',
  '--control': 'rgb(255 255 255 / 0.11)',
  '--blue': '#0a84ff',
  '--indigo': '#5e5ce6',
  '--purple': '#bf5af2',
  '--pink': '#ff375f',
  '--red': '#ff453a',
  '--orange': '#ff9f0a',
  '--yellow': '#ffd60a',
  '--green': '#30d158',
  '--teal': '#64d2ff',
  '--graphite': '#98989d',
  '--silver': '#d1d1d6',
  '--accent': '#0a84ff',
  '--accent-fg': '#fff',
};

// colors.toml is flat `key = "value"` lines; anything else (tables, arrays, broken lines) is skipped, not fatal.
export function parseColorsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    // Unquoted values are not TOML, but a hand-edited `muted = #7a6a45` still means the colour.
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']\S*))\s*(?:#.*)?$/.exec(raw);
    if (!m) continue;
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (value) out[m[1].toLowerCase()] = value;
  }
  return out;
}

// '#rgb', '#rrggbb', '#rrggbbaa' (alpha dropped), 'rgb(r, g, b)' or 'rgb(r g b)'.
export function parseColor(v: string | undefined): Rgb | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as Rgb;
  m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as Rgb;
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x))) as Rgb;
  return null;
}

// Hyprland colours: config syntax 'rgba(d4af3799)' / 'rgb(d4af37)' (RRGGBB[AA]) or the AARRGGBB hex hyprctl prints
// ('99d4af37', '0xffd4af37', leading zero bytes dropped). A gradient ('... 45deg') gives its first colour.
export function parseHyprColor(v: string | number | undefined): Rgb | null {
  if (typeof v === 'number') return Number.isFinite(v) ? [(v >>> 16) & 255, (v >>> 8) & 255, v & 255] : null;
  const first = v?.trim().split(/\s+/)[0];
  if (!first) return null;
  const cfg = /^rgba?\(([0-9a-f]{6})(?:[0-9a-f]{2})?\)$/i.exec(first);
  if (cfg) return parseColor(cfg[1]);
  const argb = /^(?:0x)?([0-9a-f]{1,8})$/i.exec(first);
  if (argb) return parseHyprColor(parseInt(argb[1], 16));
  return parseColor(first);
}

const hex = (c: Rgb) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
const rgba = (c: Rgb, a: number) => `rgb(${c.map(Math.round).join(' ')} / ${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((x, i) => x + (b[i] - x) * t) as Rgb;
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Black or white text on the accent, whichever reads better (the .btn.primary label).
export const accentForeground = (accent: Rgb) => (contrast(accent, [0, 0, 0]) >= contrast(accent, [255, 255, 255]) ? '#000' : '#fff');

// colors.toml → tokens. Keys left out fall back: accent ← blue ← color4, lighter_background ← background mixed
// with foreground, named colours ← their colorN, then Graphite's. null when there is no colour to build on.
export function paletteFromColors(colors: Record<string, string>, name?: string): DesktopPalette | null {
  const c = (...keys: string[]) => {
    for (const k of keys) {
      const v = parseColor(colors[k]);
      if (v) return v;
    }
    return null;
  };
  const bgIn = c('background', 'color0');
  const fgIn = c('foreground', 'color7', 'color15');
  const accentIn = c('accent', 'blue', 'color4');
  if (!bgIn && !fgIn && !accentIn) return null;
  const declared = colors.mode?.toLowerCase();
  const light = declared === 'light' || (declared !== 'dark' && bgIn !== null && luminance(bgIn) > 0.4);
  const bg = bgIn ?? (light ? ([242, 242, 245] as Rgb) : ([11, 11, 13] as Rgb));
  const fg = fgIn ?? (light ? ([29, 29, 31] as Rgb) : ([245, 245, 247] as Rgb));
  const elevated = c('lighter_background') ?? mix(bg, fg, light ? 0.04 : 0.06);
  const elevated2 = mix(elevated, fg, light ? 0.04 : 0.035);
  const accent = accentIn ?? (parseColor(GRAPHITE['--blue']) as Rgb);
  // Same alphas as Graphite (dark) and Light: the palette changes the tint, not the hierarchy.
  const a = light
    ? { fill: [0.05, 0.08, 0.12, 0.18], sep: 0.14, hair: 0.2, scrim: 0.3, label: [0.78, 0.5, 0.28], control: 0.58 }
    : { fill: [0.04, 0.07, 0.11, 0.16], sep: 0.08, hair: 0.12, scrim: 0.5, label: [0.62, 0.34, 0.18], control: 0.11 };
  const named = (fallback: string, ...keys: string[]) => hex(c(...keys) ?? (parseColor(GRAPHITE[fallback]) as Rgb));
  const tokens: Record<string, string> = {
    '--bg': hex(bg),
    '--bg-elevated': hex(elevated),
    '--bg-elevated-2': hex(elevated2),
    '--fill-1': rgba(fg, a.fill[0]),
    '--fill-2': rgba(fg, a.fill[1]),
    '--fill-3': rgba(fg, a.fill[2]),
    '--fill-4': rgba(fg, a.fill[3]),
    '--separator': rgba(fg, a.sep),
    '--hairline': rgba(fg, a.hair),
    '--material-thin': rgba(elevated2, 0.55),
    '--material': rgba(elevated, 0.72),
    '--material-thick': rgba(mix(bg, elevated, 0.5), 0.86),
    '--scrim': rgba([0, 0, 0], a.scrim),
    '--label': hex(fg),
    '--label-2': rgba(fg, a.label[0]),
    '--label-3': rgba(fg, a.label[1]),
    '--label-4': rgba(fg, a.label[2]),
    '--control': rgba(fg, a.control),
    '--blue': named('--blue', 'blue', 'color4'),
    '--indigo': named('--indigo', 'bright_blue', 'color12'),
    '--purple': named('--purple', 'magenta', 'color5'),
    '--pink': named('--pink', 'bright_magenta', 'color13'),
    '--red': named('--red', 'red', 'color1'),
    '--orange': named('--orange', 'orange', 'bright_red', 'color9'),
    '--yellow': named('--yellow', 'yellow', 'color3'),
    '--green': named('--green', 'green', 'color2'),
    '--teal': named('--teal', 'cyan', 'color6'),
    '--graphite': hex(c('muted') ?? mix(bg, fg, 0.55)),
    '--silver': hex(c('light_foreground') ?? mix(bg, fg, 0.8)),
    '--accent': hex(accent),
    '--accent-fg': accentForeground(accent),
  };
  return { source: 'omarchy', ...(name ? { name } : {}), mode: light ? 'light' : 'dark', tokens };
}

// Hyprland without Omarchy: Graphite, accent from the active border.
export function paletteFromAccent(accent: Rgb): DesktopPalette {
  return { source: 'hyprland', mode: 'dark', tokens: { ...GRAPHITE, '--accent': hex(accent), '--accent-fg': accentForeground(accent) } };
}

// The omarchy/current directories to read, newest layout first (Omarchy moved current/ from ~/.config to the
// XDG state dir).
export function omarchyCurrentDirs(env: NodeJS.ProcessEnv, home = os.homedir()): string[] {
  // XDG paths are POSIX paths: path.posix keeps the answer the same when the checks run on Windows.
  const p = path.posix;
  const state = env.XDG_STATE_HOME && p.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : p.join(home, '.local', 'state');
  const config = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  return [p.join(state, 'omarchy', 'current'), p.join(config, 'omarchy', 'current')];
}

function readOmarchy(dirs: string[]): DesktopPalette | null {
  for (const dir of dirs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, 'theme', 'colors.toml'), 'utf8');
    } catch {
      continue;
    }
    let name: string | undefined;
    try {
      name = fs.readFileSync(path.join(dir, 'theme.name'), 'utf8').trim().slice(0, 80) || undefined;
    } catch {
      // Older layouts have no theme.name.
    }
    const p = paletteFromColors(parseColorsToml(text.slice(0, 64 * 1024)), name);
    if (p) return p;
  }
  return null;
}

function hyprActiveBorder(env: NodeJS.ProcessEnv): Promise<Rgb | null> {
  // hyprctl only answers inside a Hyprland session.
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('hyprctl', ['-j', 'getoption', 'general:col.active_border'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        // Field by version: 'gradient' (0.4x+), 'custom' (older), 'int' for a plain colour.
        const o = JSON.parse(stdout) as { gradient?: string; custom?: string; int?: number };
        resolve(parseHyprColor(o.gradient ?? o.custom ?? o.int));
      } catch {
        resolve(null);
      }
    });
  });
}

export class DesktopTheme extends EventEmitter {
  state: DesktopThemeState = { available: false, palette: null };
  private readonly dirs: string[];
  private watchers: fs.FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private socket: net.Socket | null = null;
  private stopped = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    super();
    this.dirs = omarchyCurrentDirs(env);
  }

  // Settles once the first palette is known: the renderer's get() waits on it, so the first paint has it.
  ready: Promise<void> = Promise.resolve();

  start(): Promise<void> {
    return (this.ready = this.reload().then(() => {
      this.arm();
      this.listenHyprland();
    }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.socket?.destroy();
  }

  private async reload(): Promise<void> {
    const omarchy = readOmarchy(this.dirs);
    const border = omarchy ? null : await hyprActiveBorder(this.env);
    const palette = omarchy ?? (border ? paletteFromAccent(border) : null);
    const next: DesktopThemeState = { available: palette !== null, palette };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    log.info(palette ? `palette from ${palette.source}${palette.name ? ` (${palette.name})` : ''}, ${palette.mode}` : 'no Omarchy or Hyprland theme');
    this.emit('change', next);
  }

  // `theme set` writes several files in a row: one reload once it settles.
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload().finally(() => this.arm());
    }, 300);
  }

  // Watches omarchy/ (current/ appearing or being replaced) and current/ (theme/ swapped, theme.name rewritten).
  // Re-armed after every reload: a watcher on a replaced directory keeps following the deleted one.
  private arm(): void {
    if (this.stopped) return;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const dir of this.dirs) {
      for (const target of [path.dirname(dir), dir, path.join(dir, 'theme')]) {
        try {
          const w = fs.watch(target, { persistent: false }, () => this.schedule());
          w.on('error', () => this.schedule());
          this.watchers.push(w);
        } catch {
          // Not there (yet): the parent's watcher sees it arrive.
        }
      }
    }
  }

  // Without Omarchy the colour lives in Hyprland's config: its event socket says when that is reloaded.
  private listenHyprland(): void {
    const sig = this.env.HYPRLAND_INSTANCE_SIGNATURE;
    const runtime = this.env.XDG_RUNTIME_DIR;
    if (!sig || !runtime || /[/\\]/.test(sig)) return;
    const s = net.connect(path.join(runtime, 'hypr', sig, '.socket2.sock'));
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf = (buf + chunk).slice(-4096);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      if (lines.some((l) => l.startsWith('configreloaded>>'))) this.schedule();
    });
    // No socket (older Hyprland path, not a Hyprland session): the file watchers still cover Omarchy.
    s.on('error', () => undefined);
    s.unref();
    this.socket = s;
  }
}
