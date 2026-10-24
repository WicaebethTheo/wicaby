// Self-check for the Hyprland theme (apps/desktop/src/main/features/desktop-theme-linux.ts):
// - the colors.toml parser (comments, quotes) and Hyprland's colour syntaxes (config and hyprctl);
// - colors.toml → tokens: every tokens.css token, light mode, the fallbacks for missing keys;
// - the watcher: a swapped Omarchy theme directory is picked up, nothing at all means unavailable.
// Usage: node tools/checks/desktop-theme-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-desktop-theme-'));
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
const out = path.join(tmp, 'desktop-theme-linux.mjs');
await build({ entryPoints: [path.join(root, 'src/main/features/desktop-theme-linux.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const { parseColorsToml, parseColor, parseHyprColor, paletteFromColors, paletteFromAccent, omarchyCurrentDirs, accentForeground, DesktopTheme } = await import(pathToFileURL(out).href);

// ---- Parser ----
assert.deepEqual(
  parseColorsToml(['# comment', 'mode = "dark"', "accent = '#D4AF37'  # inline", 'muted=#7a6a45', '[table]', 'broken', 'empty = ""', 'Blue = "#112233"'].join('\r\n')),
  { mode: 'dark', accent: '#D4AF37', muted: '#7a6a45', blue: '#112233' },
);
assert.deepEqual(parseColor('#abc'), [170, 187, 204]);
assert.deepEqual(parseColor('#d4af3799'), [212, 175, 55]);
assert.deepEqual(parseColor('rgb(1, 2, 300)'), [1, 2, 255]);
assert.equal(parseColor('gold'), null);
// hyprctl prints AARRGGBB without leading zero bytes; the config writes rgba(RRGGBBAA).
assert.deepEqual(parseHyprColor('99d4af37 558a6d2a 45deg'), [212, 175, 55]);
assert.deepEqual(parseHyprColor('rgba(d4af3799) rgba(8a6d2a55) 45deg'), [212, 175, 55]);
assert.deepEqual(parseHyprColor('rgb(33ccff)'), [51, 204, 255]);
assert.deepEqual(parseHyprColor('1c1914 0deg'), [28, 25, 20]);
assert.deepEqual(parseHyprColor('0xffd4af37'), [212, 175, 55]);
assert.deepEqual(parseHyprColor(0xee33ccff), [51, 204, 255]);
assert.equal(parseHyprColor(''), null);
assert.equal(accentForeground([212, 175, 55]), '#000');
assert.equal(accentForeground([30, 102, 245]), '#fff');

// ---- Mapping ----
// Every token the generated Graphite block defines (renderer/tokens.css), no more, no less.
const css = fs.readFileSync(path.join(root, 'src/renderer/tokens.css'), 'utf8');
const graphiteBlock = /\[data-theme='graphite'\] \{([^}]*)\}/.exec(css)[1];
const tokenNames = [...graphiteBlock.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]).sort();

const gold = `mode = "dark"
accent = "#d4af37"
muted = "#7a6a45"
background = "#0f0d0a"
lighter_background = "#1c1914"
foreground = "#e8dcc0"
light_foreground = "#f2e8d0"
red = "#c8553d"
yellow = "#f0c75e"
orange = "#e09a3e"
green = "#a8b56a"
cyan = "#e6c87a"
blue = "#d4af37"
magenta = "#b8864b"
bright_blue = "#e8c45a"
bright_magenta = "#d1a066"
hyprland_active_border = "rgba(d4af3799) rgba(8a6d2a55) 45deg"
`;
const g = paletteFromColors(parseColorsToml(gold), 'gold-oled');
assert.equal(g.source, 'omarchy');
assert.equal(g.name, 'gold-oled');
assert.equal(g.mode, 'dark');
assert.deepEqual(Object.keys(g.tokens).sort(), tokenNames, 'the palette sets every tokens.css token');
assert.equal(g.tokens['--bg'], '#0f0d0a');
assert.equal(g.tokens['--bg-elevated'], '#1c1914');
assert.equal(g.tokens['--label'], '#e8dcc0');
assert.equal(g.tokens['--label-2'], 'rgb(232 220 192 / 0.62)');
assert.equal(g.tokens['--fill-1'], 'rgb(232 220 192 / 0.04)');
assert.equal(g.tokens['--scrim'], 'rgb(0 0 0 / 0.5)');
assert.equal(g.tokens['--accent'], '#d4af37');
assert.equal(g.tokens['--accent-fg'], '#000', 'dark text on a gold accent');
assert.equal(g.tokens['--blue'], '#d4af37');
assert.equal(g.tokens['--indigo'], '#e8c45a');
assert.equal(g.tokens['--purple'], '#b8864b');
assert.equal(g.tokens['--pink'], '#d1a066');
assert.equal(g.tokens['--teal'], '#e6c87a');
assert.equal(g.tokens['--orange'], '#e09a3e');
assert.equal(g.tokens['--graphite'], '#7a6a45');
assert.equal(g.tokens['--silver'], '#f2e8d0');
assert.match(g.tokens['--material'], /^rgb\(28 25 20 \/ 0\.72\)$/);

// Light mode: Light's alphas, white text on a deep blue accent.
const latte = paletteFromColors(parseColorsToml('mode = "light"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\naccent = "#1e66f5"\n'));
assert.equal(latte.mode, 'light');
assert.equal(latte.tokens['--fill-1'], 'rgb(76 79 105 / 0.05)');
assert.equal(latte.tokens['--label-2'], 'rgb(76 79 105 / 0.78)');
assert.equal(latte.tokens['--scrim'], 'rgb(0 0 0 / 0.3)');
assert.equal(latte.tokens['--accent-fg'], '#fff');
// No mode key: a pale background reads as light, a dark one as dark.
assert.equal(paletteFromColors({ background: '#fafafa', foreground: '#222222' }).mode, 'light');
assert.equal(paletteFromColors({ background: '#111111' }).mode, 'dark');

// Missing keys: only the numbered palette (accent ← color4, named colours ← colorN, elevated ← bg/fg mix),
// then Graphite's named colours for what is left.
const numbered = paletteFromColors({ color0: '#000000', color1: '#ff0000', color4: '#0000ff', color7: '#ffffff', color9: '#ff8000' });
assert.equal(numbered.tokens['--bg'], '#000000');
assert.equal(numbered.tokens['--label'], '#ffffff');
assert.equal(numbered.tokens['--accent'], '#0000ff');
assert.equal(numbered.tokens['--accent-fg'], '#fff');
assert.equal(numbered.tokens['--red'], '#ff0000');
assert.equal(numbered.tokens['--orange'], '#ff8000');
assert.equal(numbered.tokens['--green'], '#30d158', 'Graphite green when the theme has none');
assert.equal(numbered.tokens['--bg-elevated'], '#0f0f0f', '6% of the foreground over the background');
assert.deepEqual(Object.keys(numbered.tokens).sort(), tokenNames);
// Accent only: Graphite's canvas around it.
assert.equal(paletteFromColors({ accent: '#ff00ff' }).tokens['--bg'], '#0b0b0d');
assert.equal(paletteFromColors({}), null);
assert.equal(paletteFromColors({ mode: 'dark', accent: 'not a colour' }), null);

// Hyprland only: Graphite with the border colour as accent.
const hypr = paletteFromAccent([212, 175, 55]);
assert.equal(hypr.source, 'hyprland');
assert.equal(hypr.tokens['--bg'], '#0b0b0d');
assert.equal(hypr.tokens['--accent'], '#d4af37');
assert.equal(hypr.tokens['--accent-fg'], '#000');
assert.deepEqual(Object.keys(hypr.tokens).sort(), tokenNames);

assert.deepEqual(omarchyCurrentDirs({}, '/h'), ['/h/.local/state/omarchy/current', '/h/.config/omarchy/current']);
assert.deepEqual(omarchyCurrentDirs({ XDG_STATE_HOME: '/s', XDG_CONFIG_HOME: '/c' }, '/h'), ['/s/omarchy/current', '/c/omarchy/current']);
assert.deepEqual(omarchyCurrentDirs({ XDG_STATE_HOME: 'relative' }, '/h')[0], '/h/.local/state/omarchy/current', 'a relative XDG dir is ignored');

// ---- Watcher (no HYPRLAND_INSTANCE_SIGNATURE: hyprctl and the event socket stay out of it) ----
// The module only runs on Linux (XDG paths, Omarchy's directory swap): on Windows the watcher is not exercised.
if (process.platform === 'linux') {
  const env = { XDG_STATE_HOME: path.join(tmp, 'state'), XDG_CONFIG_HOME: path.join(tmp, 'config') };
  const none = new DesktopTheme(env);
  await none.start();
  assert.deepEqual(none.state, { available: false, palette: null }, 'no Omarchy, no Hyprland: unavailable');
  none.stop();

  // Old layout under ~/.config, then `omarchy theme set`: a new theme directory renamed over the old one.
  const current = path.join(env.XDG_CONFIG_HOME, 'omarchy', 'current');
  const writeTheme = (dir, toml) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'colors.toml'), toml);
  };
  writeTheme(path.join(current, 'theme'), gold);
  fs.writeFileSync(path.join(current, 'theme.name'), 'gold-oled\n');
  const theme = new DesktopTheme(env);
  await theme.start();
  assert.equal(theme.state.available, true);
  assert.equal(theme.state.palette.name, 'gold-oled');
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no change event after the theme swap')), 5000);
    theme.on('change', (s) => {
      clearTimeout(timer);
      resolve(s);
    });
  });
  writeTheme(path.join(current, 'next'), 'mode = "light"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\naccent = "#1e66f5"\n');
  fs.rmSync(path.join(current, 'theme'), { recursive: true });
  fs.renameSync(path.join(current, 'next'), path.join(current, 'theme'));
  fs.writeFileSync(path.join(current, 'theme.name'), 'catppuccin-latte\n');
  const s = await changed;
  assert.equal(s.palette.name, 'catppuccin-latte');
  assert.equal(s.palette.mode, 'light');
  assert.equal(s.palette.tokens['--accent'], '#1e66f5');
  theme.stop();
} else {
  console.log('desktop-theme-check: watcher skipped off Linux');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`desktop-theme-check: parser, mapping${process.platform === 'linux' ? ' and watcher' : ''} ok`);
