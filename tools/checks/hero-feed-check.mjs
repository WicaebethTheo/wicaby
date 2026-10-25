// Featured banner sources (#19): apps/desktop/src/renderer/lib/hero-feed.ts (queries, parents, picking, the
// Automatic banner unchanged with the default settings), the settings validation in main/core/settings.ts, and mock
// Emby answering the banner's query on a collection.
// Run: node tools/checks/hero-feed-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { dedupe } from '../../apps/desktop/src/renderer/lib/items.ts';

const desktop = path.join(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-hero-'));
const bundle = async (entry, name, plugins = []) => {
  const outfile = path.join(tmp, name);
  await build({ entryPoints: [path.join(desktop, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', plugins });
  return import(pathToFileURL(outfile).href);
};
const { autoFeatured, heroParents, heroQuery, heroQueryable, isVideoLibrary, pickFeatured, seriesToAsk } = await bundle('src/renderer/lib/hero-feed.ts', 'hero.mjs');
const { defaultSettings: sharedDefaults } = await bundle('src/shared/default-settings.ts', 'defaults.mjs');
const DEFAULT = sharedDefaults('').ui.hero;
const feed = (patch = {}) => ({ ...DEFAULT, ...patch });

// ---- Queries: the source's sort and filter go to the server ----
const q = (patch) => heroQuery(feed(patch), 'lib');
assert.deepEqual(
  { ...q({ source: 'random' }) },
  { ParentId: 'lib', Recursive: true, IncludeItemTypes: 'Movie,Series', Filters: undefined, SortBy: 'Random', SortOrder: undefined, ImageTypes: 'Backdrop', Limit: 15 },
);
assert.equal(q({ source: 'recent' }).SortBy, 'DateCreated');
assert.equal(q({ source: 'recent' }).SortOrder, 'Descending');
assert.equal(q({ source: 'topRated' }).SortBy, 'CommunityRating');
assert.equal(q({ source: 'favorites' }).Filters, 'IsFavorite');
assert.equal(q({ source: 'favorites', hideWatched: true }).Filters, 'IsFavorite,IsUnplayed');
assert.equal(q({ source: 'unwatched' }).Filters, 'IsUnplayed');
// Continue watching: episodes (not shows), no backdrop filter (theirs is the series'), never IsUnplayed.
assert.deepEqual([q({ source: 'resume', hideWatched: true }).Filters, q({ source: 'resume' }).IncludeItemTypes, q({ source: 'resume' }).ImageTypes, q({ source: 'resume' }).SortBy], ['IsResumable', 'Movie,Episode', undefined, 'DatePlayed']);
assert.equal(q({ types: 'movies' }).IncludeItemTypes, 'Movie');
assert.equal(q({ types: 'shows' }).IncludeItemTypes, 'Series');
assert.equal(q({ count: 20 }).Limit, 60);

// ---- Parents: chosen collections, else chosen video libraries, else all of them ----
const lib = (Id, CollectionType, ServerId = 'A') => ({ Id, Name: Id, CollectionType, ServerId });
const libs = [lib('m', 'movies'), lib('s', 'tvshows'), lib('x', undefined), lib('mu', 'music'), lib('b', 'books'), lib('p', 'photos'), lib('pl', 'playlists'), lib('m2', 'movies', 'B'), lib('px', 'movies', 'P')];
assert.deepEqual(libs.filter(isVideoLibrary).map((l) => l.Id), ['m', 's', 'x', 'm2', 'px']);
const usable = (sid) => sid !== 'P';
const ids = (list) => list.map((p) => `${p.serverId}:${p.id}`);
assert.deepEqual(ids(heroParents(feed(), libs, usable)), ['A:m', 'A:s', 'A:x', 'B:m2']);
assert.deepEqual(ids(heroParents(feed({ libraries: ['B:m2', 'A:mu'] }), libs, usable)), ['B:m2'], 'never music, even if chosen');
assert.deepEqual(ids(heroParents(feed({ libraries: ['A:gone'] }), libs, usable)), ['A:m', 'A:s', 'A:x', 'B:m2'], 'a choice that is gone falls back to all');
assert.deepEqual(ids(heroParents(feed({ collections: ['A:bs1', 'P:bs2', 'srv:with:colon:bs3'], libraries: ['A:m'] }), libs, usable)), ['A:bs1', 'srv:with:colon:bs3']);
assert.deepEqual(heroParents(feed(), libs, () => false), [], 'no server takes the query: none');
assert.deepEqual(['emby', 'jellyfin', 'plex', 'files', 'navidrome', undefined].map(heroQueryable), [true, true, false, false, false, false]);

// ---- Picking ----
const it = (Id, extra = {}) => ({ Id, Name: Id, Type: 'Movie', ServerId: 'A', BackdropImageTags: ['b'], ...extra });
const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();
const listA = [it('a1', { DateCreated: day(3), CommunityRating: 7 }), it('a2', { DateCreated: day(1), CommunityRating: 9, Genres: ['Horror'] }), it('nob', { BackdropImageTags: [], DateCreated: day(9) })];
const listB = [it('b1', { ServerId: 'B', DateCreated: day(5), CommunityRating: 8, Type: 'Series' }), it('b2', { ServerId: 'B', DateCreated: day(2), UserData: { Played: true } }), it('a1', { DateCreated: day(3) })];
const keys = (l) => l.map((x) => `${x.ServerId}:${x.Id}`);
assert.deepEqual(keys(pickFeatured([listA, listB], feed({ source: 'recent' }))), ['B:b1', 'A:a1', 'B:b2', 'A:a2'], 'one date order across libraries, no backdrop-less title, no duplicate');
assert.deepEqual(keys(pickFeatured([listA, listB], feed({ source: 'topRated' }))).slice(0, 3), ['A:a2', 'B:b1', 'A:a1']);
assert.deepEqual(keys(pickFeatured([listA, listB], feed({ source: 'recent', excludeGenres: ['horror'], hideWatched: true }))), ['B:b1', 'A:a1'], 'genres (any case) and watched titles out');
assert.deepEqual(keys(pickFeatured([listA, listB], feed({ source: 'recent', types: 'shows' }))), ['B:b1']);
assert.equal(pickFeatured([Array.from({ length: 40 }, (_, i) => it(`m${i}`))], feed({ source: 'recent', count: 10 })).length, 10);
// Random: a permutation of the pool, logos first.
const pool = Array.from({ length: 30 }, (_, i) => it(`r${i}`, i % 3 === 0 ? { ImageTags: { Logo: 'l' } } : {}));
const rolled = pickFeatured([pool], feed({ source: 'random', count: 20 }));
assert.equal(rolled.length, 20);
assert.ok(rolled.slice(0, 10).every((x) => x.ImageTags?.Logo), 'logos first');
assert.equal(new Set(rolled.map((x) => x.Id)).size, 20);
const orders = new Set(Array.from({ length: 8 }, () => pickFeatured([pool], feed({ source: 'random', count: 20 })).map((x) => x.Id).join()));
assert.ok(orders.size > 1, 'a new set each roll');

// ---- Automatic with the default settings: the banner as it was before #19 ----
const before = (resume, latest) =>
  resume.length > 0
    ? resume.filter((i) => i.BackdropImageTags?.length || i.ParentBackdropImageTags?.length).slice(0, 5)
    : dedupe(latest).filter((i) => i.BackdropImageTags?.length && (i.Type === 'Movie' || i.Type === 'Series')).slice(0, 5);
const ep = (Id) => ({ Id, Name: Id, Type: 'Episode', ServerId: 'A', ParentBackdropImageTags: ['b'], UserData: { PlaybackPositionTicks: 5 } });
const resume = [ep('e1'), it('r1', { BackdropImageTags: [] }), it('r2'), ep('e2'), it('r3'), ep('e3'), it('r4'), { ...it('v1'), Type: 'Video' }];
const latest = [...listA, ...listB, it('l1', { Type: 'Episode' }), it('l2'), it('l3'), it('l4'), it('l5')];
for (const [r, l] of [[resume, latest], [[], latest], [[], []], [[it('nobackdrop', { BackdropImageTags: [] })], latest]]) {
  assert.deepEqual(keys(autoFeatured(r, l, DEFAULT)), keys(before(r, l)), 'Automatic unchanged with the defaults');
}
// Its filters: shows only skips the films in progress; nothing in progress left means the newest additions.
assert.deepEqual(keys(autoFeatured(resume, latest, feed({ types: 'shows' }))), ['A:e1', 'A:e2', 'A:e3']);
assert.deepEqual(keys(autoFeatured([it('r9')], latest, feed({ types: 'shows' }))), ['B:b1']);
assert.deepEqual(keys(autoFeatured(resume, latest, feed({ count: 10 }))).length, 7);
// Excluded genres: any spelling or language of one genre, and an episode by its series' genres (it has none itself).
const anime = { ...ep('e9'), SeriesId: 's9' };
assert.deepEqual(keys(pickFeatured([[it('h1', { Genres: ['Horreur'] }), it('h2', { Genres: ['Science-fiction'] }), it('ok')]], feed({ source: 'recent', excludeGenres: ['Horror', 'Science Fiction'] }))), ['A:ok']);
assert.deepEqual(seriesToAsk([anime, it('m')], feed({ excludeGenres: ['Animation'] })).map((x) => x.Id), ['e9']);
assert.deepEqual(seriesToAsk([anime], DEFAULT), [], 'no request without an excluded genre');
assert.deepEqual(keys(autoFeatured([anime, ep('e1')], [], feed({ excludeGenres: ['Animation'] }), new Map([['s9', ['Animation']]]))), ['A:e1']);

// ---- Settings: defaults and validation ----
assert.deepEqual(DEFAULT, { source: 'auto', types: 'both', libraries: [], collections: [], excludeGenres: [], count: 5, intervalS: 8, hideWatched: false });
const { SettingsService } = await bundle('src/main/core/settings.ts', 'settings.mjs', [
  {
    name: 'electron-stub',
    setup: (b) => {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(tmp)}, getLocale: () => 'en', isReady: () => false, on() {} };` }));
    },
  },
]);
const svc = new SettingsService(path.join(tmp, 'settings.json'));
assert.deepEqual(svc.value.ui.hero, DEFAULT, 'a new file: Automatic');
let h = svc.update({ ui: { hero: { source: 'random', types: 'shows', count: 15, intervalS: 15, hideWatched: true, excludeGenres: ['Horror', 'Horror', ''], libraries: ['A:m'] } } }).ui.hero;
assert.deepEqual(h, { ...DEFAULT, source: 'random', types: 'shows', count: 15, intervalS: 15, hideWatched: true, excludeGenres: ['Horror'], libraries: ['A:m'] });
h = svc.update({ ui: { hero: { source: 'everything', types: 'music', count: 7, intervalS: 3, hideWatched: 'yes', libraries: 'A:m', collections: [42, 'x'.repeat(300), 'A:bs'] } } }).ui.hero;
assert.deepEqual(h, { ...DEFAULT, excludeGenres: ['Horror'], collections: ['A:bs'] }, 'bad values fall back');
assert.equal(svc.update({ ui: { hero: { excludeGenres: Array.from({ length: 100 }, (_, i) => `g${i}`) } } }).ui.hero.excludeGenres.length, 64);
assert.deepEqual(svc.update({ ui: { hero: null } }).ui.hero.collections, ['A:bs'], 'a null section keeps the current one');
const old = path.join(tmp, 'old.json');
fs.writeFileSync(old, JSON.stringify({ ui: { heroEnabled: true, heroAutoplay: false } }));
assert.deepEqual(new SettingsService(old).value.ui.hero, DEFAULT, 'a file from before #19: Automatic');

// ---- Mock Emby: a collection takes the banner's filters (the collection view still lists every entry) ----
const E = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'mock-server', 'mock-emby.mjs')).href);
E.hooks.log = () => {};
const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  const emby = `http://127.0.0.1:${server.address().port}/emby`;
  const login = await fetch(`${emby}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="hero-check", Version="1"' },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  }).then((r) => r.json());
  const H = { 'X-Emby-Token': login.AccessToken };
  const base = `${emby}/Users/${login.User.Id}`;
  const ids = (query) => fetch(`${base}/Items?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined))}`, { headers: H }).then((r) => r.json()).then((r) => r.Items.map((x) => x.Id));
  assert.ok((await fetch(`${base}/FavoriteItems/movie-x8`, { method: 'POST', headers: H })).ok);
  assert.deepEqual(await ids({ ParentId: 'boxset-1' }), ['movie-x0', 'movie-x8', 'movie-x16', 'movie-x24'], 'the collection view: every entry');
  assert.deepEqual(await ids(heroQuery(feed({ source: 'favorites', types: 'movies' }), 'boxset-1')), ['movie-x8'], 'Favorites on a collection: its favourite members only');
  assert.deepEqual(await ids(heroQuery(feed({ source: 'random', types: 'shows' }), 'boxset-1')), [], 'Shows on a film collection: nothing');
} finally {
  server.close();
}

console.log('hero-feed-check: ok');
