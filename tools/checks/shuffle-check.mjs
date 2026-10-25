// Shuffle screen (#18, apps/desktop/src/renderer/lib/shuffle.ts): genre merging across servers and languages, the
// synopsis cleaner, the decade filter, the set picker; then the Emby mock answers the queries the screen sends
// (SortBy=Random, pipe-separated Genres, Years, MinCommunityRating, /Genres of one library).
// Usage: node tools/checks/shuffle-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-shuffle-')), 'shuffle.mjs');
await build({ entryPoints: [path.join(root, 'apps/desktop/src/renderer/lib/shuffle.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error' });
const S = await import(pathToFileURL(out).href);

// ---- Servers ----
assert.equal(S.canShuffle('emby'), true);
assert.equal(S.canShuffle('jellyfin'), true);
for (const k of ['plex', 'files', 'navidrome', 'iptv', undefined]) assert.equal(S.canShuffle(k), false, `canShuffle(${k})`);

// ---- Genres ----
assert.equal(S.genreKey('Science-Fiction'), 'science fiction');
assert.equal(S.genreKey('  Ciencia   ficción '), 'science fiction');
assert.equal(S.genreKey('Comédie'), 'comedy');
assert.equal(S.genreKey('Bélico'), 'war');
assert.equal(S.genreKey('Animé'), 'anime');
assert.notEqual(S.genreKey('Anime'), S.genreKey('Animation'), 'anime and animation stay apart');
assert.equal(S.genreKey('Mystère'), 'mystery');
assert.equal(S.genreKey('Suspense'), 'thriller');
assert.equal(S.genreKey('Komödie'), 'comedy');
assert.equal(S.genreKey('Some Local Genre'), 'some local genre', 'unknown names keep their folded form');

const merged = S.mergeGenres([
  ['Action', 'Comédie', 'Science-Fiction', 'Drame', 'Animation'],
  ['Acción', 'Comedia', 'Ciencia ficción', 'drama', 'Terror', 'Animación', 'Action'],
  null,
  ['Horreur', 'Anime', 'Animé', '  ', 'Western'],
]);
const byKey = Object.fromEntries(merged.map((g) => [g.key, g]));
assert.deepEqual(byKey.action, { key: 'action', name: 'Action', sources: ['Action', 'Acción'] }, 'the first spelling names it, each spelling once');
assert.deepEqual(byKey.comedy.sources, ['Comédie', 'Comedia']);
assert.deepEqual(byKey['science fiction'].sources, ['Science-Fiction', 'Ciencia ficción']);
assert.deepEqual(byKey.drama.sources, ['Drame', 'drama']);
assert.deepEqual(byKey.horror.sources, ['Terror', 'Horreur']);
assert.deepEqual(byKey.animation.sources, ['Animation', 'Animación']);
assert.deepEqual(byKey.anime.sources, ['Anime', 'Animé']);
assert.equal(merged.length, 8, `blank names dropped (got ${merged.map((g) => g.key)})`);
assert.deepEqual(merged.map((g) => g.name), [...merged.map((g) => g.name)].sort((a, b) => a.localeCompare(b)), 'sorted by name');

// ---- Synopsis ----
assert.equal(S.cleanText('<p>Line one<br>line two<br/>&amp; three</p><p>Next&nbsp;one&#8217;s &#x2014; <i>end</i>&hellip;</p>'), 'Line one\nline two\n& three\nNext one’s — end…');
assert.equal(S.cleanText('Plain &unknown; text &#0; &lt;b&gt;'), 'Plain &unknown; text &#0; <b>');
assert.equal(S.cleanText('a<br><br><br><br>b'), 'a\n\nb', 'runs of breaks fold to one blank line');
assert.equal(S.cleanText(undefined), '');

// ---- Decades ----
assert.equal(S.decadeYears('1990'), '1990,1991,1992,1993,1994,1995,1996,1997,1998,1999');
assert.equal(S.decadeYears('older').split(',').length, 50);
assert.equal(S.decadeYears('older').split(',')[0], '1920');
assert.equal(S.decadeYears(''), undefined);
assert.equal(S.decadeYears('1993'), undefined, 'only the listed decades');

// ---- Picking a set ----
const movie = (id, server = 'A', tmdb) => ({ Id: id, Name: id, Type: 'Movie', ServerId: server, ProviderIds: tmdb ? { Tmdb: tmdb } : undefined });
const series = (id, server = 'A') => ({ Id: id, Name: id, Type: 'Series', ServerId: server });
const keep = (l) => l;
const ids = (l) => l.map((x) => `${x.ServerId}:${x.Id}`);
const cont = S.continueTitles([{ Id: 'ep1', Name: 'Ep', Type: 'Episode', SeriesId: 's1', SeriesName: 'Show', ServerId: 'A' }, movie('m2')]);
assert.deepEqual(ids(cont), ['A:s1', 'A:m2'], 'an episode in Continue Watching stands for its series');
const lists = [[movie('m1', 'A', '7'), series('s1'), movie('m2'), movie('m3')], [movie('x1', 'B', '7'), movie('x2', 'B'), series('s1', 'B')], null];
assert.deepEqual(ids(S.pickSet(lists, cont, [], 5, keep)), ['A:m1', 'B:x2', 'B:s1', 'A:m3'], 'Continue Watching and the same title on another server dropped');
assert.deepEqual(ids(S.pickSet([[series('s9', 'B'), { ...series('s8', 'B'), Name: 'show' }]], cont, [], 5, keep)), ['B:s9'], 'a series in Continue Watching on another server dropped by name');
assert.deepEqual(ids(S.pickSet(lists, [], [movie('m1'), movie('m2')], 3, keep)), ['A:s1', 'B:x2', 'B:s1'], 'a re-roll prefers titles not just shown');
assert.deepEqual(ids(S.pickSet([[movie('m1'), movie('m2')]], [], [movie('m1')], 5, keep)), ['A:m2', 'A:m1'], 'the previous set fills in when nothing else is left');
assert.equal(S.pickSet([Array.from({ length: 12 }, (_, i) => movie(`r${i}`))], [], []).length, S.SET_SIZE);
assert.deepEqual(S.pickSet([null, null], [], []), []);

// ---- Mock server ----
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};
const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
try {
  const login = await fetch(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="shuffle-check", Version="1"' },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  }).then((r) => r.json());
  const H = { 'X-Emby-Token': login.AccessToken };
  const get = (p, q) => fetch(`${base}${p}?${new URLSearchParams(q)}`, { headers: H }).then((r) => r.json());
  const items = (q) => get(`/Users/${login.User.Id}/Items`, { Recursive: 'true', IncludeItemTypes: 'Movie,Series', SortBy: 'Random', ...q });

  const a = await items({ Limit: '30' });
  const b = await items({ Limit: '30' });
  assert.equal(a.Items.length, 30);
  assert.ok(a.TotalRecordCount > 30);
  assert.notDeepEqual(a.Items.map((x) => x.Id), b.Items.map((x) => x.Id), 'SortBy=Random: another order each call');

  const g = await items({ Genres: 'Drame|Comédie' });
  assert.ok(g.Items.length > 0 && g.Items.every((x) => x.Genres.some((n) => n === 'Drame' || n === 'Comédie')), 'Genres: any of the pipe-separated names');
  assert.ok(g.Items.some((x) => x.Genres.includes('Drame')) && g.Items.some((x) => x.Genres.includes('Comédie')));

  const y = await items({ Years: S.decadeYears('2000') });
  assert.ok(y.Items.length > 0 && y.Items.every((x) => x.ProductionYear >= 2000 && x.ProductionYear <= 2009), 'Years');
  const r = await items({ MinCommunityRating: '8' });
  assert.ok(r.Items.length > 0 && r.Items.every((x) => x.CommunityRating >= 8), 'MinCommunityRating');

  const shows = await get('/Genres', { ParentId: 'lib-shows', IncludeItemTypes: 'Movie,Series', Recursive: 'true' });
  assert.deepEqual(shows.Items.map((x) => x.Name), ['Science-fiction'], "/Genres of one library");
  const all = await get('/Genres', { IncludeItemTypes: 'Movie,Series', Recursive: 'true' });
  assert.ok(!all.Items.some((x) => x.Name === 'Bande dessinée'), '/Genres keeps to the types asked for');
  const genres = S.mergeGenres([all.Items.map((x) => x.Name), ['Science Fiction', 'Drama', 'Crime']]);
  assert.deepEqual(genres.find((x) => x.key === 'science fiction').sources, ['Science-fiction', 'Science Fiction']);
  assert.deepEqual(genres.find((x) => x.key === 'crime').sources, ['Policier', 'Crime']);
  console.log(`shuffle-check: ok (${merged.length} merged genres, mock random/genres/years/rating)`);
} finally {
  server.close();
}
