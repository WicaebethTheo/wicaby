// Themes and accents: the shared Graphite tokens as the desktop draws them (tokens.css, one [data-theme] block per
// theme and [data-accent] per accent). Settings stores the theme id and the accent's index in tokens.json order,
// as the Android apps do. "system" follows iOS between light and graphite.
export const ACCENTS = ['blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'green', 'graphite'];
// In the pickers' order (Android ThemePicker): Automatic first.
export const THEME_IDS = ['system', 'graphite', 'oled', 'slate', 'cinema', 'contrast', 'light'];
const THEMES = new Set(THEME_IDS);
const dark = matchMedia('(prefers-color-scheme: dark)');

let current = 'graphite';

function paint(): void {
  const id = current === 'system' ? (dark.matches ? 'graphite' : 'light') : current;
  const root = document.documentElement;
  root.dataset.theme = id;
  // The status bar and the app switcher's tint follow the canvas.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0b0b0d');
}

dark.addEventListener('change', () => current === 'system' && paint());

export function applyTheme(id: string, accent: number): void {
  current = THEMES.has(id) ? id : 'graphite';
  document.documentElement.dataset.accent = ACCENTS[accent] ?? ACCENTS[0];
  paint();
}
