// Shuffle screen (issue #18): pure helpers, no IPC and no runes, so tools/checks/shuffle-check.mjs runs them.
import type { BaseItem } from '../../shared/models';
import { itemKey, merge, shuffled, unseen } from './items';

// Emby and Jellyfin only: SortBy=Random, pipe-separated Genres, Years and MinCommunityRating on /Items. Not a
// caps flag: fixtures/server-caps.json is shared with the Android app, which has no shuffle screen.
export const canShuffle = (kind: string | undefined): boolean => kind === 'emby' || kind === 'jellyfin';

export const VIDEO_COLLECTIONS = ['movies', 'tvshows'];
export const SHUFFLE_TYPES = 'Movie,Series';
export const SET_SIZE = 5;

// Common genre names in Spanish, French, German, Italian and Portuguese, as normalised by norm(), to the English one.
const SYNONYMS: Record<string, string> = {
  accion: 'action', azione: 'action', acao: 'action',
  aventura: 'adventure', aventure: 'adventure', abenteuer: 'adventure', avventura: 'adventure',
  animacion: 'animation', animazione: 'animation', animacao: 'animation', zeichentrick: 'animation', 'dessin anime': 'animation',
  comedia: 'comedy', comedie: 'comedy', komodie: 'comedy', commedia: 'comedy',
  drame: 'drama', dramma: 'drama',
  terror: 'horror', horreur: 'horror', orrore: 'horror', epouvante: 'horror', 'epouvante horreur': 'horror',
  'ciencia ficcion': 'science fiction', 'science fiction': 'science fiction', 'sci fi': 'science fiction', 'ficcao cientifica': 'science fiction', fantascienza: 'science fiction',
  documental: 'documentary', documentaire: 'documentary', dokumentarfilm: 'documentary', dokumentation: 'documentary', documentario: 'documentary',
  familia: 'family', famille: 'family', familie: 'family', famiglia: 'family',
  suspense: 'thriller', suspens: 'thriller',
  romantique: 'romance', liebesfilm: 'romance', romantico: 'romance',
  crimen: 'crime', policier: 'crime', polar: 'crime', krimi: 'crime', crimine: 'crime',
  misterio: 'mystery', mystere: 'mystery', mistero: 'mystery',
  fantasia: 'fantasy', fantastique: 'fantasy', fantastico: 'fantasy',
  guerra: 'war', guerre: 'war', belico: 'war', krieg: 'war', kriegsfilm: 'war',
  musica: 'music', musique: 'music', musik: 'music',
  historia: 'history', histoire: 'history', historique: 'history', geschichte: 'history', historie: 'history', storia: 'history', historico: 'history',
};

// Case, accents, dashes and spaces folded: "Science-Fiction", "science fiction" and "Ciencia ficción" meet.
function norm(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-_/.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function genreKey(name: string): string {
  const n = norm(name);
  return SYNONYMS[n] ?? n;
}

// One genre across servers and languages: `name` is the first spelling met (the primary server's first),
// `sources` every spelling, all sent in one pipe-separated Genres (both servers match any of them).
export interface MergedGenre {
  key: string;
  name: string;
  sources: string[];
}

export function mergeGenres(lists: (string[] | null | undefined)[], compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b)): MergedGenre[] {
  const byKey = new Map<string, MergedGenre>();
  for (const name of lists.flatMap((l) => l ?? [])) {
    if (!name.trim()) continue;
    const key = genreKey(name);
    const hit = byKey.get(key);
    if (!hit) byKey.set(key, { key, name, sources: [name] });
    else if (!hit.sources.includes(name)) hit.sources.push(name);
  }
  return [...byKey.values()].sort((a, b) => compare(a.name, b.name));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };

// A synopsis as plain text: line breaks and paragraphs kept, other tags dropped, entities decoded.
export function cleanText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The decade filter as an /Items Years list; 'older' is 1920-1969. Empty: any year.
export const DECADES = ['2020', '2010', '2000', '1990', '1980', '1970', 'older'];

export function decadeYears(decade: string): string | undefined {
  const from = decade === 'older' ? 1920 : Number(decade);
  if (!DECADES.includes(decade) || !Number.isInteger(from)) return undefined;
  const to = decade === 'older' ? 1969 : from + 9;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i).join(',');
}

// Continue Watching as titles: an episode stands for its series, which is what the shuffle lists.
export function continueTitles(items: BaseItem[]): BaseItem[] {
  return items.map((it) => (it.SeriesId ? { Id: it.SeriesId, Name: it.SeriesName ?? it.Name, Type: 'Series', ServerId: it.ServerId } : it));
}

// Up to n titles from each server's random page: one copy of a title on several servers, none of `excluded`
// (Continue Watching), and titles of the previous set only when nothing else is left, so a re-roll shows new ones.
export function pickSet(lists: (BaseItem[] | null | undefined)[], excluded: BaseItem[], previous: BaseItem[], n = SET_SIZE, mix: <T>(l: T[]) => T[] = shuffled): BaseItem[] {
  // An episode's series has no provider ids here (continueTitles), so its copies on other servers match by name.
  const series = new Set(excluded.filter((it) => it.Type === 'Series').map((it) => norm(it.Name ?? '')));
  const pool = unseen(merge(lists), excluded).filter((it) => it.Type !== 'Series' || !series.has(norm(it.Name ?? '')));
  const before = new Set(previous.map(itemKey));
  const fresh = pool.filter((it) => !before.has(itemKey(it)));
  return [...mix(fresh), ...mix(pool.filter((it) => before.has(itemKey(it))))].slice(0, n);
}
