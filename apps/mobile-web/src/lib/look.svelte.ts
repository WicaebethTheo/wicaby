// The phone's own preferences, beside the shared ones (lib settings): the look (text size, library cards, posters,
// badges, the tab bar's labels, the motion), Home's hero and Continue watching, the start tab, the player's jump and
// controls delay. Kept on the phone; applied to the document as CSS
// variables and attributes, so a change shows at once everywhere.
import { load, save } from '$tv/storage';

// The text size: 'system' follows iOS's (Réglages > Luminosité et affichage > Taille du texte, read from the
// -apple-system-body font), else a fixed scale of the 17 pt body.
export type TextSize = 'system' | number;
export const TEXT_SCALES = [0.88, 1, 1.12, 1.24, 1.36];

export interface Look {
  textSize: TextSize;
  // Library cards: the server's artwork, or a plain tint with the library's icon.
  libraryArt: boolean;
  // Posters in rows and grids: 0 small, 1 medium, 2 large.
  posterSize: number;
  // The title under each poster.
  posterTitles: boolean;
  tabLabels: boolean;
  reduceMotion: boolean;
  // The watched tick and the unplayed count on posters.
  cardBadges: boolean;
  // Home: the featured titles' rotation in seconds (0: by hand only); Continue watching as large cards or a row.
  heroSeconds: number;
  continueLarge: boolean;
  // Home's hero becomes "Resume" for what was watched within this many days (0: always the featured titles).
  resumeHeroDays: number;
  // The tab the app opens on.
  startTab: 'home' | 'libraries' | 'downloads' | 'search';
  // The player: the jump of a double tap and of the ±buttons, and how long the controls stay up.
  seekSeconds: number;
  controlsSeconds: number;
}

const DEFAULTS: Look = {
  textSize: 'system',
  libraryArt: true,
  posterSize: 1,
  posterTitles: true,
  tabLabels: true,
  reduceMotion: false,
  cardBadges: true,
  heroSeconds: 8,
  continueLarge: true,
  resumeHeroDays: 3,
  startTab: 'home',
  seekSeconds: 10,
  controlsSeconds: 3.5,
};

export const look = $state<Look>({ ...DEFAULTS, ...load<Partial<Look>>('look', {}) });

export function setLook<K extends keyof Look>(key: K, value: Look[K]): void {
  look[key] = value;
  save('look', $state.snapshot(look));
  apply();
}

// iOS's body size in this browser (17 px at the default size), as a scale; 1 where the font is unknown.
export function systemScale(): number {
  if (!CSS.supports('font', '-apple-system-body')) return 1;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font:-apple-system-body';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return px > 0 ? px / 17 : 1;
}

// The accessibility sizes go far past what the layouts hold: the scale stops at 1.4.
export const textScale = (): number => Math.min(1.4, Math.max(0.82, look.textSize === 'system' ? systemScale() : look.textSize));

export function apply(): void {
  const root = document.documentElement;
  root.style.setProperty('--text-scale', textScale().toFixed(3));
  root.toggleAttribute('data-reduce-motion', look.reduceMotion);
}

// At start, and when the app comes back (the iOS text size may have changed meanwhile).
export function initLook(): void {
  apply();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && look.textSize === 'system' && apply());
}

// A poster's width in a row for the chosen size, from the medium one.
export const posterWidth = (medium: number): number => Math.round(medium * [0.8, 1, 1.24][look.posterSize]);
// A 16:9 card's (Continue watching, Next up, thumbnails), from the medium one, never wider than the screen.
export const wideWidth = (medium: number): number => Math.round(Math.min(window.innerWidth * 0.9, medium * [0.72, 1, 1.18][look.posterSize]));
