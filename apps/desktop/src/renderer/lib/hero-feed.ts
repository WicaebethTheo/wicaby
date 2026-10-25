// What the Home featured banner shows (#19, Settings > Home and libraries > Featured banner). Pure: Home.svelte
// does the requests, tools/checks/hero-feed-check.mjs tests this.
//
// Server-side (Emby and Jellyfin /Items): the source's sort and filter (SortBy=Random / DateCreated / DatePlayed /
// CommunityRating, Filters=IsFavorite / IsResumable / IsUnplayed), the content type, the library or collection
// (ParentId) and the backdrop (ImageTypes=Backdrop). Client-side: excluded genres (Jellyfin has no exclude-genre
// parameter), the order across libraries, and the same type, watched and backdrop rules on the Automatic banner.
import type { HeroFeed, Query } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import { dedupe, itemKey, shuffled } from './items';
import { genreKey } from './shuffle';

// Plex, Navidrome and file sources do not take that /Items query: they only feed the Automatic banner.
export const heroQueryable = (kind: string | undefined): boolean => kind === 'emby' || kind === 'jellyfin';

// Video libraries only; music, books, photos, playlists and the rest never feed the banner.
export const isVideoLibrary = (lib: BaseItem): boolean => ['movies', 'tvshows', 'mixed', ''].includes(lib.CollectionType ?? '');

const SORTS: Record<Exclude<HeroFeed['source'], 'auto'>, [string, 'Ascending' | 'Descending'] | [string]> = {
  random: ['Random'],
  recent: ['DateCreated', 'Descending'],
  resume: ['DatePlayed', 'Descending'],
  topRated: ['CommunityRating', 'Descending'],
  favorites: ['DateCreated', 'Descending'],
  unwatched: ['DateCreated', 'Descending'],
};

// The /Items query for one library or collection. Asks for more than `count`: genres are dropped afterwards.
export function heroQuery(feed: HeroFeed, parentId: string): Query {
  const source = feed.source === 'auto' ? 'recent' : feed.source;
  const resume = source === 'resume';
  // Continue watching resumes episodes; the other sources show the show itself.
  const types = [feed.types !== 'shows' && 'Movie', feed.types !== 'movies' && (resume ? 'Episode' : 'Series')].filter(Boolean).join(',');
  const filters = [source === 'favorites' && 'IsFavorite', resume && 'IsResumable', !resume && (source === 'unwatched' || feed.hideWatched) && 'IsUnplayed'].filter(Boolean);
  const [sortBy, order] = SORTS[source];
  return {
    ParentId: parentId,
    Recursive: true,
    IncludeItemTypes: types,
    Filters: filters.join(',') || undefined,
    SortBy: sortBy,
    SortOrder: order,
    // Episodes carry their series' backdrop (ParentBackdropImageTags), not one of their own.
    ImageTypes: resume ? undefined : 'Backdrop',
    Limit: feed.count * 3,
  };
}

// Where the banner's titles come from: the chosen collections, else the chosen video libraries (all of them when
// none is chosen, or none of the chosen ones is still there). `usable` says which servers can be asked.
export function heroParents(feed: HeroFeed, libraries: BaseItem[], usable: (serverId: string) => boolean): { serverId: string; id: string }[] {
  if (feed.collections.length > 0) {
    return feed.collections
      .map((key) => ({ serverId: key.slice(0, key.lastIndexOf(':')), id: key.slice(key.lastIndexOf(':') + 1) }))
      .filter((p) => p.serverId && p.id && usable(p.serverId));
  }
  const video = libraries.filter((l) => l.ServerId && isVideoLibrary(l) && usable(l.ServerId));
  const chosen = video.filter((l) => feed.libraries.includes(itemKey(l)));
  return (chosen.length > 0 ? chosen : video).map((l) => ({ serverId: l.ServerId!, id: l.Id }));
}

const hasBackdrop = (it: BaseItem) => !!(it.BackdropImageTags?.length || it.ParentBackdropImageTags?.length);
const hasLogo = (it: BaseItem) => !!(it.ImageTags?.Logo || it.ParentLogoImageTag);

// Episodes have no genres on Emby and Jellyfin, their series has: series id to its genres (Home asks for them).
export type SeriesGenres = Map<string, string[]>;

// Episodes to look up in SeriesGenres: only when a genre is excluded.
export const seriesToAsk = (items: BaseItem[], feed: HeroFeed): BaseItem[] =>
  feed.excludeGenres.length > 0 ? items.filter((it) => it.Type === 'Episode' && it.SeriesId && !it.Genres?.length) : [];

// The user's filters, on any item list (the Automatic banner's too). Genres meet across case, spelling and
// language as on the Shuffle screen: excluding "Horror" also drops "Horreur".
function wanted(feed: HeroFeed, series?: SeriesGenres): (it: BaseItem) => boolean {
  const excluded = new Set(feed.excludeGenres.map(genreKey));
  return (it) =>
    (feed.types !== 'movies' || it.Type === 'Movie') &&
    (feed.types !== 'shows' || it.Type === 'Series' || it.Type === 'Episode') &&
    !(feed.hideWatched && it.UserData?.Played) &&
    !(it.Genres?.length ? it.Genres : (it.SeriesId && series?.get(it.SeriesId)) || []).some((g) => excluded.has(genreKey(g)));
}

const sortKey: Partial<Record<HeroFeed['source'], (it: BaseItem) => number>> = {
  recent: (it) => Date.parse(it.DateCreated ?? '') || 0,
  favorites: (it) => Date.parse(it.DateCreated ?? '') || 0,
  unwatched: (it) => Date.parse(it.DateCreated ?? '') || 0,
  resume: (it) => Date.parse(it.UserData?.LastPlayedDate ?? '') || 0,
  topRated: (it) => it.CommunityRating ?? 0,
};

// One list per library or collection into the banner: one order across them, filtered, `count` long.
// Random puts the titles that have a logo first (the banner then shows art, not a plain title).
export function pickFeatured(lists: BaseItem[][], feed: HeroFeed, series?: SeriesGenres): BaseItem[] {
  const ok = wanted(feed, series);
  const pool = dedupe(lists.flat()).filter((it) => hasBackdrop(it) && ok(it));
  const key = sortKey[feed.source];
  const ordered = key ? [...pool].sort((a, b) => key(b) - key(a)) : shuffled(pool);
  const out = feed.source === 'random' ? [...ordered.filter(hasLogo), ...ordered.filter((it) => !hasLogo(it))] : ordered;
  return out.slice(0, feed.count);
}

// Automatic: what the user is in the middle of, else the newest additions with art (Movies and Shows). With the
// default filters this is the banner as it always was.
export function autoFeatured(resume: BaseItem[], latest: BaseItem[], feed: HeroFeed, series?: SeriesGenres): BaseItem[] {
  const ok = wanted(feed, series);
  const inProgress = resume.filter(ok);
  if (inProgress.length > 0) return inProgress.filter(hasBackdrop).slice(0, feed.count);
  return dedupe(latest)
    .filter((i) => i.BackdropImageTags?.length && (i.Type === 'Movie' || i.Type === 'Series') && ok(i))
    .slice(0, feed.count);
}
