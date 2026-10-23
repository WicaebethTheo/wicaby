// Minimal Emby-flavoured server for UI and flow testing without a real server.
// Speaks the /emby prefix, X-Emby-Token auth and the endpoints Wicaby uses.
//   node tools/mock-server/mock-emby.mjs [port] [video-file]
// Login: user "Wika", password "wicaby".
// Remote control (sessions.mjs, cast spec CA-01): /embywebsocket?api_key=&deviceId=, Capabilities/Full, GET /Sessions
// (the dashboard's demo sessions plus the signed-in and virtual ones), /Sessions/{id}/Playing[/{cmd}], /Command[/{name}],
// /Message, SessionsStart pushes. Mock helpers (no auth, with or without /emby): GET /Mock/State (sockets, remote[]),
// POST /Mock/Sessions {...} (a virtual controllable session), POST /Mock/Sessions/{id}/{Pause|Unpause|Seek}?PositionTicks=.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bif, comicPage, zip } from './cbz-fixture.mjs';
import { epub, pdf, rar4, rar5, sevenZip, tar } from './comic-formats-fixture.mjs';
import { createSessions } from './sessions.mjs';
import { addMusic, isMusic, LOG as MUSIC_LOG, logReport, lrclibRoute, musicFilters, musicRoute, musicSource } from './music-fixture.mjs';
import { addPhotos, countAlbums, photoRoute } from './photos-fixture.mjs';
import { vc1Trailer } from './trailer-fixture.mjs';

const PORT = Number(process.argv[2] ?? 8096);
const VIDEO = process.argv[3] ? path.resolve(process.argv[3]) : null;
// Streams read with fetch() (the phone web app's remux reads Range pieces) need CORS, as both servers send it.
const STREAM_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
// MOCK_SERVER_ID / MOCK_NAME let several mocks run side by side as distinct servers (multi-server tests).
const SERVER_ID = process.env.MOCK_SERVER_ID ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SERVER_NAME = process.env.MOCK_NAME ?? 'Wicaby Mock Emby';
// MOCK_SUB_POLICY=deny: a non-admin account without the subtitle download right (X-03, 403 on RemoteSearch/Subtitles).
const SUB_DENY = process.env.MOCK_SUB_POLICY === 'deny';
const USER = { Id: 'u-wika', Name: 'Wika', HasPassword: true, HasConfiguredPassword: true, Policy: SUB_DENY ? { IsAdministrator: false, EnableSubtitleDownloading: false, EnableSubtitleManagement: false } : { IsAdministrator: true }, Configuration: { IntroSkipMode: process.env.MOCK_SKIP_MODE ?? 'ShowButton', AudioLanguagePreference: 'fre', PlayDefaultAudioTrack: true, SubtitleLanguagePreference: 'fre', SubtitleMode: 'Smart', DisplayMissingEpisodes: false, HidePlayedInLatest: true, RememberAudioSelections: true, RememberSubtitleSelections: true } };
// TP-10 "Who is watching?": the family's other public users (same ids and avatars as mock-admin/20-users.mjs; the
// disabled guest stays hidden). Password "wicaby" where HasPassword. Signed in, they browse Wika's catalogue.
export const PROFILES = [
  { Id: 'u-lea', Name: 'Léa', HasPassword: true, HasConfiguredPassword: true, PrimaryImageTag: 'lea1' },
  { Id: 'u-kids', Name: 'Enfants', HasPassword: true, HasConfiguredPassword: true, PrimaryImageTag: 'kids1' },
  { Id: 'u-marc', Name: 'Marc', HasPassword: false, HasConfiguredPassword: false },
];
export const profileFor = (name, pw) => PROFILES.find((u) => u.Name.toLowerCase() === String(name ?? '').toLowerCase() && pw === (u.HasPassword ? 'wicaby' : ''));
// Markers and trick-play are laid out over this span; set MOCK_DURATION_S to the test video's length
// so they fall inside it when really playing (the items keep their long RunTimeTicks otherwise).
const MARKER_SPAN = Number(process.env.MOCK_DURATION_S ?? 0) * 10_000_000;
const tokens = new Set();
// The user each token was issued to at sign-in: that user's hours apply to every call made with it.
export const tokenUser = new Map();
// TP-11 parental access schedules, per user (Policy.AccessSchedules), enforced like Emby: outside them that user's
// AuthenticateByName and every call with that user's token answer 401 "…not allowed access at this time.". Wika's are
// set at start with MOCK_SCHEDULE='[{"DayOfWeek":"Everyday","StartHour":8,"EndHour":20}]'; anyone's at run time with
// POST /Mock/AccessSchedules[?userId=u-lea] (the same JSON array; [] lifts them; Wika by default), or from the desktop
// admin's user editor (mock-admin/20-users.mjs keeps the policies: "Enfants" has weekday and weekend hours).
if (process.env.MOCK_SCHEDULE) USER.Policy.AccessSchedules = JSON.parse(process.env.MOCK_SCHEDULE);
const SCHEDULE_DAYS = { Everyday: [0, 1, 2, 3, 4, 5, 6], Weekday: [1, 2, 3, 4, 5], Weekend: [0, 6], Sunday: [0], Monday: [1], Tuesday: [2], Wednesday: [3], Thursday: [4], Friday: [5], Saturday: [6] };
export function scheduleAllows(list, d = new Date()) {
  if (!list?.length) return true;
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  return list.some((s) => (SCHEDULE_DAYS[s.DayOfWeek] ?? []).includes(d.getDay()) && h >= s.StartHour && h < s.EndHour);
}
// A user's live AccessSchedules: the admin store's policy (mock-admin/20-users.mjs), else Wika's own.
export async function scheduleOf(userId) {
  for (const m of await adminModules()) if (m.policyOf) return m.policyOf(USER, userId)?.AccessSchedules ?? [];
  return userId === USER.Id ? (USER.Policy?.AccessSchedules ?? []) : [];
}
export const allowedNow = async (userId) => scheduleAllows(await scheduleOf(userId));
// Lets tools/mock-server/mock-jellyfin.mjs reuse this catalogue and handler with its own item shape and logging.
export const hooks = { view: (out) => out, log: console.log };
const userData = new Map();

const palette = ['#ff4b3e', '#5ec8ff', '#f4d58d', '#8b5cf6', '#22c55e', '#f97316', '#ec4899', '#14b8a6'];
const TICKS_MIN = 600_000_000;

function ud(id) {
  if (!userData.has(id)) userData.set(id, { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false });
  return userData.get(id);
}

const items = new Map();
function add(item) {
  items.set(item.Id, item);
  return item;
}

add({ Id: 'lib-movies', Name: 'Films', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, ImageTags: { Primary: 't' } });
add({ Id: 'lib-shows', Name: 'Séries', Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true, ImageTags: { Primary: 't' } });
add({ Id: 'lib-books', Name: 'Bandes dessinées', Type: 'CollectionFolder', CollectionType: 'books', IsFolder: true, ImageTags: { Primary: 't' } });

const movieNames = [
  ['Néon Fantôme', 2024, 'Science-fiction'],
  ['La Dernière Manche', 2023, 'Drame'],
  ['Clutch', 2025, 'Action'],
  ['Uplink', 2022, 'Thriller'],
  ['Radiant', 2021, 'Aventure'],
  ['Homelab', 2024, 'Documentaire'],
  ['Mjolnir', 2020, 'Fantastique'],
  ['Gungnir', 2023, 'Fantastique'],
  ['Hexdump', 2025, 'Comédie'],
  ['Minuit à Lyon', 2019, 'Romance'],
  ['Le Signal', 2022, 'Mystère'],
  ['Onde Courte', 2021, 'Drame'],
];

const streams = [
  { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, RealFrameRate: 23.976, VideoRange: 'HDR', VideoRangeType: 'HDR10', DisplayTitle: '4K HEVC HDR10' },
  { Index: 1, Type: 'Audio', Codec: 'truehd', Language: 'fre', Channels: 8, IsDefault: true, DisplayTitle: 'Français TrueHD Atmos 7.1' },
  { Index: 2, Type: 'Audio', Codec: 'eac3', Language: 'eng', Channels: 6, DisplayTitle: 'English EAC3 5.1' },
  { Index: 3, Type: 'Subtitle', Codec: 'subrip', Language: 'fre', IsForced: true, DisplayTitle: 'Français (forcés) SRT' },
  { Index: 4, Type: 'Subtitle', Codec: 'pgssub', Language: 'eng', DisplayTitle: 'English PGS' },
];

// Per-film video stream fields (Emby style) for the item page's HDR chips: Dolby Vision 8.1, HDR10+, SDR.
const VIDEO_OVERRIDES = {
  'movie-4': { VideoRange: 'HDR', VideoRangeType: undefined, ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81', DisplayTitle: '4K HEVC Dolby Vision' },
  'movie-5': { VideoRange: 'HDR', VideoRangeType: undefined, ExtendedVideoType: 'Hdr10Plus', DisplayTitle: '4K HEVC HDR10+' },
  'movie-6': { Codec: 'h264', Width: 1920, Height: 1080, VideoRange: 'SDR', VideoRangeType: undefined, ExtendedVideoType: 'None', DisplayTitle: '1080p H264 SDR' },
};

function mediaSource(id) {
  return {
    Id: id,
    Name: 'Version 4K',
    Protocol: 'File',
    Container: 'mkv',
    Path: `/media/${id}.mkv`,
    Size: 42_000_000_000,
    Bitrate: 60_000_000,
    RunTimeTicks: items.get(id)?.RunTimeTicks,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    DefaultAudioStreamIndex: 1,
    MediaStreams: VIDEO_OVERRIDES[id] ? streams.map((st) => (st.Type === 'Video' ? { ...st, ...VIDEO_OVERRIDES[id] } : st)) : streams,
  };
}

// Versions and trailers (Wicaby Android: "Version" picker, "Bande-annonce"). Néon Fantôme has two
// MediaSources (4K Dolby Vision 8.1 VF+VO, 1080p VOST), a local trailer and a YouTube one;
// La Dernière Manche only has the YouTube one.
const VERSIONS = {
  'movie-0': () => [
    {
      ...mediaSource('movie-0'),
      Name: 'Néon Fantôme',
      MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 1608, RealFrameRate: 23.976, VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81', ExtendedVideoSubTypeDescription: 'Profile 8.1 (HDR10 compatible)', ColorTransfer: 'smpte2084', DisplayTitle: '4K Dolby Vision' },
        ...streams.slice(1),
      ],
    },
    {
      ...mediaSource('movie-0'),
      Id: 'movie-0-1080',
      Name: 'Néon Fantôme - VOST',
      Path: '/media/movie-0 - VOST.mkv',
      Size: 9_000_000_000,
      Bitrate: 18_000_000,
      DefaultAudioStreamIndex: 1,
      MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 800, RealFrameRate: 23.976, VideoRange: 'SDR', DisplayTitle: '1080p H264' },
        { Index: 1, Type: 'Audio', Codec: 'ac3', Language: 'eng', Channels: 6, IsDefault: true, DisplayTitle: 'English AC3 5.1' },
        { Index: 2, Type: 'Subtitle', Codec: 'subrip', Language: 'fre', IsForced: true, IsDefault: true, DisplayTitle: 'Français SRT' },
      ],
    },
  ],
};
// X-02 version memory: S1E1 and S1E2 come as 1080p (the server's default, first) and 2160p HEVC DV.
for (const ep of ['ep-1-1', 'ep-1-2']) {
  VERSIONS[ep] = () => [
    { ...VERSIONS['movie-0']()[1], Id: ep, Name: '1080p', Path: `/media/${ep}.mkv`, RunTimeTicks: items.get(ep)?.RunTimeTicks },
    { ...VERSIONS['movie-0']()[0], Id: `${ep}-uhd`, Name: '2160p', Path: `/media/${ep} - UHD.mkv`, RunTimeTicks: items.get(ep)?.RunTimeTicks },
  ];
}
let pbiFailNext = false;
// R-B network recovery (GET /Mock/Stream/Fail, /Mock/Down): the next `count` video streams answer 503 or are cut
// after `after` bytes; down: every /emby route answers 503, as a server restarting behind a proxy.
let streamFail = { mode: 'none', count: 0, after: 0 };
let serverDown = false;
// X-03: subtitles downloaded through RemoteSearch (mock-admin/40-metadata.mjs), external streams of every version.
const addedSubs = new Map();
function sourcesFor(id) {
  if (isMusic(items.get(id))) return [musicSource(items.get(id))];
  const all = VERSIONS[id]?.() ?? [mediaSource(id)];
  const extra = addedSubs.get(id) ?? [];
  return all.map((s) => ({
    ...s,
    MediaStreams: [
      ...s.MediaStreams,
      ...extra.map((x, i) => {
        const Index = s.MediaStreams.length + i;
        return { ...x, Index, IsExternal: true, DeliveryMethod: 'External', DeliveryUrl: `/Videos/${id}/${s.Id}/Subtitles/${Index}/0/Stream.srt` };
      }),
    ],
  }));
}
const TRAILERS = { 'movie-0': ['trailer-0'] };
const YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
movieNames.forEach(([name, year, genre], i) => {
  add({
    Id: `movie-${i}`,
    Name: name,
    Type: 'Movie',
    MediaType: 'Video',
    ParentId: 'lib-movies',
    ProductionYear: year,
    OfficialRating: ['TP', '12', '16'][i % 3],
    CommunityRating: 6 + (i % 4) * 0.7,
    RunTimeTicks: (88 + i * 7) * TICKS_MIN,
    Genres: [genre],
    Overview: `${name} : un récit généré par le serveur de test de Wicaby pour vérifier les affiches, les rangées, la page détail et la lecture.`,
    Taglines: ['Le direct play, sans compromis.'],
    ImageTags: { Primary: 'p', Logo: undefined },
    BackdropImageTags: ['b'],
    // The first films carry provider ids, so a second mock shows them as the same titles.
    ProviderIds: i < 4 ? { Imdb: `tt900000${i}`, Tmdb: String(9000 + i) } : undefined,
    DateCreated: new Date(Date.now() - i * 86400000).toISOString(),
    People: [
      { Id: 'person-1', Name: 'Alex Martin', Role: 'Rôle principal', Type: 'Actor', PrimaryImageTag: 'x' },
      { Id: 'person-2', Name: 'Sam Leroy', Role: 'Second rôle', Type: 'Actor', PrimaryImageTag: 'x' },
    ],
  });
});

add({ Id: 'trailer-0', Name: 'Néon Fantôme · Bande-annonce', Type: 'Trailer', MediaType: 'Video', RunTimeTicks: 2.5 * TICKS_MIN, ImageTags: { Primary: 'p' }, BackdropImageTags: ['b'] });
Object.assign(items.get('movie-0'), { LocalTrailerCount: 1, RemoteTrailers: [{ Url: YOUTUBE, Name: 'Bande-annonce' }] });
Object.assign(items.get('movie-1'), { LocalTrailerCount: 0, RemoteTrailers: [{ Url: YOUTUBE, Name: 'Trailer' }] });

const series = add({
  Id: 'series-1',
  Name: 'Nemesis Hub',
  ProviderIds: { Tvdb: '424242' },
  Type: 'Series',
  ParentId: 'lib-shows',
  IsFolder: true,
  ProductionYear: 2024,
  OfficialRating: '12',
  CommunityRating: 8.4,
  Genres: ['Science-fiction'],
  Overview: 'Une file d’attente, un match trouvé, et rien ne se passe comme prévu.',
  ImageTags: { Primary: 'p' },
  BackdropImageTags: ['b'],
  ChildCount: 2,
});
for (let s = 1; s <= 2; s++) {
  add({ Id: `season-${s}`, Name: `Saison ${s}`, Type: 'Season', IsFolder: true, SeriesId: series.Id, SeriesName: series.Name, IndexNumber: s, ParentId: series.Id, ImageTags: { Primary: 'p' } });
  for (let e = 1; e <= 8; e++) {
    add({
      Id: `ep-${s}-${e}`,
      Name: `Épisode ${e} · ${['En file', 'Match trouvé', 'Accepter', 'Clutch', 'Overtime', 'Radiant', 'GG', 'Rematch'][e - 1]}`,
      Type: 'Episode',
      MediaType: 'Video',
      SeriesId: series.Id,
      SeriesName: series.Name,
      SeasonId: `season-${s}`,
      SeasonName: `Saison ${s}`,
      ParentIndexNumber: s,
      IndexNumber: e,
      RunTimeTicks: 42 * TICKS_MIN,
      Overview: 'Résumé de test de l’épisode.',
      ImageTags: { Primary: 'p' },
      ParentBackdropItemId: series.Id,
      ParentBackdropImageTags: ['b'],
      SeriesPrimaryImageTag: 'p',
    });
  }
}
// Season 3 airs soon: virtual episodes, only listed by /Shows/Upcoming (servers hide missing episodes by default).
for (let e = 1; e <= 2; e++) {
  add({
    Id: `ep-3-${e}`,
    Name: `Épisode ${e} · ${['Retour en file', 'Nouvelle saison'][e - 1]}`,
    Type: 'Episode',
    MediaType: 'Video',
    LocationType: 'Virtual',
    SeriesId: series.Id,
    SeriesName: series.Name,
    SeasonId: 'season-3',
    SeasonName: 'Saison 3',
    ParentIndexNumber: 3,
    IndexNumber: e,
    PremiereDate: new Date(Date.now() + e * 7 * 86400000).toISOString(),
    ImageTags: { Primary: 'p' },
    ParentBackdropItemId: series.Id,
    ParentBackdropImageTags: ['b'],
    SeriesPrimaryImageTag: 'p',
  });
}
// Browse-redesign additions: a bigger catalogue, logos and BlurHashes. MOCK_MOVIES=<n>: n generated films instead of
// 48 (large-library scroll and memory measurements).
const BLURHASHES = ['LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'LGF5]+Yk^6#M@-5c,1J5@[or[Q6.', 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH'];
const extraGenres = ['Science-fiction', 'Drame', 'Action', 'Thriller', 'Aventure', 'Comédie', 'Animation', 'Policier'];
for (let i = 0; i < Number(process.env.MOCK_MOVIES || 48); i++) {
  add({
    Id: `movie-x${i}`,
    Name: `${['Horizon', 'Lumière', 'Écho', 'Sillage', 'Orbite', 'Mirage', 'Vertige', 'Rivage'][i % 8]} ${Math.floor(i / 8) + 1}`,
    Type: 'Movie',
    MediaType: 'Video',
    ParentId: 'lib-movies',
    ProductionYear: 1995 + ((i * 7) % 30),
    OfficialRating: ['TP', '12', '16'][i % 3],
    CommunityRating: 5.5 + ((i * 3) % 40) / 10,
    RunTimeTicks: (84 + ((i * 11) % 70)) * TICKS_MIN,
    Genres: [extraGenres[i % extraGenres.length]],
    Overview: 'Film de démonstration généré par le serveur de test pour remplir la grille de la bibliothèque.',
    ImageTags: { Primary: 'p' },
    BackdropImageTags: ['b'],
    DateCreated: new Date(Date.now() - (i + 12) * 86400000).toISOString(),
  });
}
for (const id of ['movie-0', 'movie-2', 'movie-4', 'series-1']) items.get(id).ImageTags.Logo = 'l';
[...items.values()].forEach((it, i) => {
  if (it.ImageTags?.Primary && it.Type !== 'CollectionFolder') it.ImageBlurHashes = { Primary: { [it.ImageTags.Primary]: BLURHASHES[i % BLURHASHES.length] } };
});
items.get('series-1').People = [
  { Id: 'person-1', Name: 'Alex Martin', Role: 'Nora', Type: 'Actor', PrimaryImageTag: 'x' },
  { Id: 'person-2', Name: 'Sam Leroy', Role: 'Malik', Type: 'Actor', PrimaryImageTag: 'x' },
  { Id: 'person-3', Name: 'Inès Garnier', Role: 'Réalisation', Type: 'Director' },
];
for (const [id, name] of [['person-1', 'Alex Martin'], ['person-2', 'Sam Leroy'], ['person-3', 'Inès Garnier']]) {
  add({ Id: id, Name: name, Type: 'Person', ImageTags: id === 'person-3' ? {} : { Primary: 'x' }, Overview: `${name}, personnalité fictive du serveur de test.` });
}

// Comic books, generated on first download (numbered PNG pages; page 10 of the first is a double spread).
// ComicInfo.xml carries series/number and the manga flag; the webtoon has tall pages only. One book per
// format the reader opens (comic-formats-check reads each one), plus a text EPUB and a .mobi it refuses.
const COMICS = {
  'comic-1': { name: 'Les Cartographes, tome 1', pages: 24, hue: [86, 132, 214], spread: 10, info: '<Series>Les Cartographes</Series><Number>1</Number>' },
  'comic-2': { name: 'Nuit Blanche', pages: 14, hue: [214, 96, 86], deflate: true, info: '<Series>Nuit Blanche</Series><Manga>YesAndRightToLeft</Manga>' },
  // RAR 5 with a "Deleted" last image (an ad page) in ComicInfo.xml.
  'comic-3': { name: 'Archive RAR', pages: 6, hue: [150, 110, 200], ext: 'cbr', ad: true, info: '<Series>Archive RAR</Series><Pages><Page Image="6" Type="Deleted"/></Pages>' },
  'comic-4': { name: 'Ligne de fuite', pages: 8, hue: [96, 180, 140], tall: true, deflate: true },
  'comic-5': { name: 'Carnet RAR 4', pages: 5, hue: [200, 160, 80], ext: 'cbr', rar4: true },
  'comic-6': { name: 'Les Îles 7z', pages: 5, hue: [80, 170, 190], ext: 'cb7' },
  'comic-7': { name: 'Bobine', pages: 5, hue: [190, 90, 150], ext: 'cbt' },
  'comic-8': { name: 'Atlas PDF', pages: 4, hue: [120, 150, 90], ext: 'pdf', spread: 3 },
  'comic-9': { name: 'Planches EPUB', pages: 5, hue: [230, 130, 60], ext: 'epub' },
  'comic-10': { name: 'Roman EPUB', pages: 0, hue: [0, 0, 0], ext: 'epub', text: true },
  'comic-11': { name: 'Livre MOBI', pages: 0, hue: [0, 0, 0], ext: 'mobi' },
};
// No server cover (ImageTags without Primary, as Emby leaves a CBZ without a plugin): the clients show the first page.
const NO_COVER = new Set(['comic-2', 'comic-3', 'comic-4', 'comic-5', 'comic-6', 'comic-7', 'comic-8', 'comic-9']);
const ARCHIVE_WRITERS = { cbz: zip, cbr: (e, c) => (c.rar4 ? rar4(e) : rar5(e)), cb7: sevenZip, cbt: tar };
const bookCache = new Map();
// The book's file, whatever its format (the name stays from when every book was a CBZ).
function cbz(id) {
  if (!bookCache.has(id)) {
    const c = COMICS[id];
    const ext = c.ext ?? 'cbz';
    const images = Array.from({ length: c.pages }, (_, i) => (i + 1 === c.spread ? comicPage(i + 1, c.hue, 1200, 900) : c.tall ? comicPage(i + 1, c.hue, 500, 1800) : comicPage(i + 1, c.hue)));
    let data;
    if (ext === 'pdf') data = pdf(images, c.name);
    else if (ext === 'epub') data = epub(images, { title: c.name, text: c.text });
    else if (ext === 'mobi') data = Buffer.from('\0'.repeat(60) + 'BOOKMOBI', 'latin1');
    else {
      const pages = images.map((png, i) => ({ name: `${c.name}/${String(i + 1).padStart(2, '0')}.png`, data: png, store: !c.deflate }));
      if (c.ad) pages.push({ name: `${c.name}/99-pub.png`, data: comicPage(99, [40, 40, 40], 300, 450) });
      data = ARCHIVE_WRITERS[ext]([...pages, { name: '__MACOSX/._01.png', data: Buffer.from('x') }, { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo>${c.info ?? ''}</ComicInfo>`) }], c);
    }
    bookCache.set(id, data);
  }
  return bookCache.get(id);
}
// Book folders (the desktop Folders view): one with its own image, one borrowing its first book's cover, a nested one
// whose books have no cover either (a folder icon). comic-1..4 stay at the library root (comic-cover-check lists it).
add({ Id: 'bookdir-formats', Name: 'Formats', Type: 'Folder', IsFolder: true, ParentId: 'lib-books', ImageTags: {} });
add({ Id: 'bookdir-more', Name: 'Autres formats', Type: 'Folder', IsFolder: true, ParentId: 'bookdir-formats', ImageTags: {} });
add({ Id: 'bookdir-novels', Name: 'Romans', Type: 'Folder', IsFolder: true, ParentId: 'lib-books', ImageTags: { Primary: 'p' } });
const BOOK_DIRS = { 'comic-5': 'bookdir-formats', 'comic-6': 'bookdir-formats', 'comic-9': 'bookdir-formats', 'comic-7': 'bookdir-more', 'comic-8': 'bookdir-more', 'comic-10': 'bookdir-novels', 'comic-11': 'bookdir-novels' };
Object.entries(COMICS).forEach(([id, c], i) => {
  const ext = c.ext ?? 'cbz';
  add({ Id: id, Name: c.name, Type: 'Book', MediaType: 'Book', ParentId: BOOK_DIRS[id] ?? 'lib-books', Path: `/books/${c.name}.${ext}`, Container: ext, ProductionYear: 2020 + i, Genres: ['Bande dessinée'], Overview: `${c.name} : album de test généré par le serveur de démonstration.`, ImageTags: NO_COVER.has(id) ? {} : { Primary: 'p' }, DateCreated: new Date().toISOString() });
});
ud('comic-1').PlaybackPositionTicks = 5 * 10_000;

// Cinema mode: a second local trailer, which Intros (Emby cinema mode) hands out for every other film; and a youtu.be link.
add({ Id: 'trailer-3', Name: 'Uplink · Bande-annonce', Type: 'Trailer', MediaType: 'Video', ImageTags: { Primary: 'p' } });
TRAILERS['movie-3'] = ['trailer-3'];
items.get('movie-3').LocalTrailerCount = 1;
items.get('movie-2').RemoteTrailers = [{ Url: 'https://youtu.be/eRsGyueVLvQ' }];
// A VC-1 local trailer (trailer-fixture.mjs): Android has no decoder for it, so a direct play shows black (0.10.2).
add({ Id: 'trailer-6', Name: 'Bande-annonce VC-1', Type: 'Trailer', MediaType: 'Video', RunTimeTicks: 30 * 10_000_000, ImageTags: { Primary: 'p' } });
VIDEO_OVERRIDES['trailer-6'] = { Codec: 'vc1', Width: 1920, Height: 1080, VideoRange: 'SDR', VideoRangeType: undefined, ExtendedVideoType: 'None', DisplayTitle: '1080p VC-1' };
TRAILERS['movie-6'] = ['trailer-6'];
items.get('movie-6').LocalTrailerCount = 1;
let vc1File = null;

// Extras (SpecialFeatures): Video items with an ExtraType, outside every library listing.
const EXTRAS = { 'movie-0': ['extra-0-1', 'extra-0-2'], 'series-1': ['extra-s1-1'] };
add({ Id: 'extra-0-1', Name: 'Scènes coupées', Type: 'Video', ExtraType: 'DeletedScene', MediaType: 'Video', RunTimeTicks: 6 * TICKS_MIN, ImageTags: { Primary: 'p' } });
add({ Id: 'extra-0-2', Name: 'Le making-of', Type: 'Video', ExtraType: 'BehindTheScenes', MediaType: 'Video', RunTimeTicks: 14 * TICKS_MIN });
add({ Id: 'extra-s1-1', Name: 'Dans les coulisses', Type: 'Video', ExtraType: 'Featurette', MediaType: 'Video', RunTimeTicks: 9 * TICKS_MIN, ImageTags: { Primary: 'p' } });

ud('movie-2').PlaybackPositionTicks = 40 * TICKS_MIN;
ud('ep-1-3').PlaybackPositionTicks = 12 * TICKS_MIN;
// X-01: what Continue Watching sorts by; series-1 itself keeps a null LastPlayedDate, as Emby can send it.
ud('movie-2').LastPlayedDate = '2026-10-09T20:00:00.0000000Z';
ud('ep-1-3').LastPlayedDate = '2026-10-10T21:00:00.0000000Z';
ud('ep-1-1').Played = true;
ud('ep-1-2').Played = true;
ud('movie-0').IsFavorite = true;
// Watch history (Wicaby desktop History page, jump list "Continue watching"): today, yesterday, earlier.
const HOUR = 3_600_000;
const playedAgo = (id, h) => (ud(id).LastPlayedDate = new Date(Date.now() - h * HOUR).toISOString());
playedAgo('ep-1-3', 1);
playedAgo('movie-2', 2);
playedAgo('ep-1-2', 26);
playedAgo('ep-1-1', 27);
Object.assign(ud('movie-1'), { Played: true, PlayCount: 1 });
playedAgo('movie-1', 74);
Object.assign(ud('movie-5'), { Played: true, PlayCount: 1 });
playedAgo('movie-5', 12 * 24);

// Emby-style chapters with intro/credits markers mixed in, as the real server sends them.
function chapters(item) {
  const span = MARKER_SPAN || item.RunTimeTicks;
  const at = (f) => Math.round(span * f);
  return [
    { Name: 'Ouverture', StartPositionTicks: 0, MarkerType: 'Chapter', ChapterIndex: 0, ImageTag: 'c0' },
    { Name: 'Intro', StartPositionTicks: at(0.05), MarkerType: 'IntroStart', ChapterIndex: 1 },
    { Name: 'Intro', StartPositionTicks: at(0.2), MarkerType: 'IntroEnd', ChapterIndex: 2 },
    { Name: 'Le plan', StartPositionTicks: at(0.2), MarkerType: 'Chapter', ChapterIndex: 3, ImageTag: 'c3' },
    { Name: 'Retournement', StartPositionTicks: at(0.5), MarkerType: 'Chapter', ChapterIndex: 4, ImageTag: 'c4' },
    { Name: 'Dernière manche', StartPositionTicks: at(0.72), MarkerType: 'Chapter', ChapterIndex: 5, ImageTag: 'c5' },
    { Name: 'Générique', StartPositionTicks: at(0.85), MarkerType: 'CreditsStart', ChapterIndex: 6 },
  ];
}

// index.bif: one numbered frame every 10 s (at most 200 frames), built once per item.
const bifCache = new Map();
function bifFor(id) {
  if (!bifCache.has(id)) {
    const span = MARKER_SPAN || items.get(id)?.RunTimeTicks || 0;
    const interval = Math.max(10_000, Math.ceil(span / 10_000 / 200 / 1000) * 1000);
    const count = Math.max(1, Math.floor(span / 10_000 / interval));
    const frames = Array.from({ length: count }, (_, i) => comicPage(i, [70 + ((i * 37) % 160), 110, 190 - ((i * 23) % 120)], 320, 180));
    bifCache.set(id, bif(frames, interval));
  }
  return bifCache.get(id);
}

function chapterSvg(n) {
  const hue = palette[n % palette.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="100%" height="100%" fill="${hue}"/><rect width="100%" height="100%" fill="#000" fill-opacity="0.35"/><text x="24" y="240" font-family="Arial" font-weight="700" font-size="64" fill="#fff">${n}</text></svg>`;
}

// Recursive=true: any depth of ParentId (book folders nest).
function under(x, parent) {
  for (let p = items.get(x.ParentId), n = 0; p && n < 8; p = items.get(p.ParentId), n++) if (p.ParentId === parent) return true;
  return false;
}

function view(item) {
  const out = { ...item, ServerId: SERVER_ID, UserData: { ...ud(item.Id) } };
  const total = item.RunTimeTicks;
  if (total && out.UserData.PlaybackPositionTicks) out.UserData.PlayedPercentage = (out.UserData.PlaybackPositionTicks / total) * 100;
  if (item.Type === 'Series' || item.Type === 'Season') {
    const eps = [...items.values()].filter((x) => x.Type === 'Episode' && x.LocationType !== 'Virtual' && (x.SeriesId === item.Id || x.SeasonId === item.Id));
    out.UserData.UnplayedItemCount = eps.filter((e) => !ud(e.Id).Played).length;
    out.RecursiveItemCount = eps.length;
  }
  // Fixture-private fields (music-fixture.mjs: _replayGain, _lyricStream) never leave the mock.
  for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
  if (item.MediaType === 'Video' || isMusic(item)) out.MediaSources = sourcesFor(item.Id);
  if (isMusic(item)) out.MediaStreams = out.MediaSources[0].MediaStreams;
  if (item.MediaType === 'Video' && item.RunTimeTicks) out.Chapters = chapters(item);
  return hooks.view(out, item);
}

// Both servers' SortName: lower case, a leading English article dropped (Jellyfin's default SortRemoveWords).
const sortNameOf = (x) => (x.SortName ?? x.Name ?? '').toLowerCase().replace(/^(the|a|an) /, '');

function list(arr, q) {
  const start = Number(q.get('StartIndex') ?? 0);
  const limit = Number(q.get('Limit') ?? 1000);
  // As both servers: a track in a list carries its MediaSources and MediaStreams only when Fields names them.
  const fields = (q.get('Fields') ?? q.get('fields') ?? '').split(',');
  const trim = (v) => {
    if (v.Type !== 'Audio') return v;
    if (!fields.includes('MediaSources')) delete v.MediaSources;
    if (!fields.includes('MediaStreams')) delete v.MediaStreams;
    return v;
  };
  return { Items: arr.slice(start, start + limit).map((x) => trim(view(x))), TotalRecordCount: arr.length, StartIndex: start };
}

function svg(id, type, w, h) {
  const item = items.get(id);
  if (type === 'Logo') {
    const t = (item?.Name ?? id).slice(0, 22);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240" viewBox="0 0 800 240"><text x="0" y="170" font-family="Georgia, serif" font-style="italic" font-weight="700" font-size="${Math.min(150, Math.round(1300 / Math.max(6, t.length)))}" fill="#ffffff">${t}</text></svg>`;
  }
  const label = item?.Name ?? (id.startsWith('person') ? 'Acteur' : id);
  const hash = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const c1 = palette[hash % palette.length];
  const c2 = palette[(hash + 3) % palette.length];
  const isBackdrop = type === 'Backdrop' || type === 'Thumb';
  const W = isBackdrop ? 1920 : w;
  const H = isBackdrop ? 1080 : h;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="#101114"/></linearGradient>
<radialGradient id="r" cx="0.75" cy="0.25" r="0.8"><stop offset="0" stop-color="${c2}" stop-opacity="0.55"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/>
${[...Array(14)].map((_, i) => `<line x1="0" y1="${(i * H) / 14}" x2="${W}" y2="${(i * H) / 14 + H * 0.3}" stroke="#ffffff" stroke-opacity="0.04" stroke-width="2"/>`).join('')}
<text x="${W * 0.07}" y="${H * 0.88}" font-family="Bahnschrift, Arial Narrow, sans-serif" font-weight="700" font-size="${Math.round(W / (isBackdrop ? 14 : 7.5))}" fill="#ece8e1" text-transform="uppercase">${label.toUpperCase().slice(0, 18)}</text>
<text x="${W * 0.07}" y="${H * 0.12}" font-family="Consolas, monospace" font-size="${Math.round(W / 28)}" fill="#ece8e1" fill-opacity="0.6">0x${hash.toString(16).padStart(8, '0')}</text></svg>`;
}

// Browser clients (the TV web app, apps/tv-web) send a CORS preflight before any request carrying auth headers.
function preflight(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(type === 'application/json' && body !== undefined ? JSON.stringify(body) : body);
}

const tokenOf = (req, q) => req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(String(req.headers['x-emby-authorization'] ?? ''))?.[1];
function authed(req, q) {
  const token = tokenOf(req, q);
  return token && tokens.has(token);
}
const authFields = (req) => Object.fromEntries([...String(req.headers['x-emby-authorization'] ?? req.headers.authorization ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

// ---- Live TV, playlists and collections (added for the Live TV / home work) ----
// Views, guide data, timers and recordings live in memory; programs cover the
// last 3 h and the next 24 h from server start.
// MOCK_LIVETV=off: a server without a tuner (no Live TV view, /LiveTv/Info IsEnabled false), for the setup page.
const NO_LIVETV = process.env.MOCK_LIVETV === 'off';
if (!NO_LIVETV) add({ Id: 'lib-livetv', Name: 'TV en direct', Type: 'CollectionFolder', CollectionType: 'livetv', IsFolder: true, ImageTags: { Primary: 't' } });
add({ Id: 'lib-playlists', Name: 'Playlists', Type: 'CollectionFolder', CollectionType: 'playlists', IsFolder: true, ImageTags: { Primary: 't' } });
add({ Id: 'lib-collections', Name: 'Collections', Type: 'CollectionFolder', CollectionType: 'boxsets', IsFolder: true, ImageTags: { Primary: 't' } });

const CHANNEL_NAMES = ['Wika Info', 'Ciné Club', 'Docu Planète', 'Sport Direct', 'Junior', 'Musique Live', 'Séries+', 'Arte Test', 'Météo 24', 'Histoire', 'Cuisine TV', 'Nature HD'];
const CHANNELS = Array.from({ length: 30 }, (_, i) => {
  const name = `${CHANNEL_NAMES[i % CHANNEL_NAMES.length]}${i >= CHANNEL_NAMES.length ? ` ${Math.floor(i / CHANNEL_NAMES.length) + 1}` : ''}`;
  return add({ Id: `ch-${i + 1}`, Name: name, Type: 'TvChannel', MediaType: 'Video', ChannelNumber: String(i + 1), Number: String(i + 1), ImageTags: { Primary: 'c' } });
});
const SHOWS = [
  ['Le Journal', false, 30], ['Grand Format', true, 60], ['Les Explorateurs', true, 45], ['Film : Néon Fantôme', false, 120],
  ['Match en direct', false, 90], ['Dessins animés', true, 30], ['Concert acoustique', false, 60], ['Enquêtes', true, 45],
  ['Magazine', true, 30], ['Documentaire', false, 90],
];
const GUIDE_START = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3 * 3_600_000;
const GUIDE_END = GUIDE_START + 27 * 3_600_000;
const programs = [];
CHANNELS.forEach((ch, ci) => {
  let t = GUIDE_START;
  let k = 0;
  while (t < GUIDE_END) {
    const [name, series, mins] = SHOWS[(ci * 3 + k) % SHOWS.length];
    const dur = mins * 60_000;
    programs.push({
      Id: `prog-${ci + 1}-${k}`,
      Name: name,
      Type: 'Program',
      ChannelId: ch.Id,
      ChannelName: ch.Name,
      StartDate: new Date(t).toISOString(),
      EndDate: new Date(t + dur).toISOString(),
      IsSeries: series,
      SeriesId: series ? `pseries-${name}` : undefined,
      EpisodeTitle: series ? `Épisode ${k + 1}` : undefined,
      IsNew: k % 4 === 0,
      Overview: `${name} sur ${ch.Name} : programme fictif généré par le serveur de test pour remplir le guide.`,
      ImageTags: k % 3 === 0 ? { Primary: 'p' } : {},
    });
    t += dur;
    k++;
  }
});
const timers = new Map();
const seriesTimers = new Map();
const progById = new Map(programs.map((p) => [p.Id, p]));
function progView(p) {
  const timer = [...timers.values()].find((x) => x.ProgramId === p.Id);
  const st = [...seriesTimers.values()].find((x) => x.SeriesId && x.SeriesId === p.SeriesId);
  return { ...p, ServerId: SERVER_ID, TimerId: timer?.Id, SeriesTimerId: st?.Id ?? timer?.SeriesTimerId };
}
function chanView(ch) {
  const now = Date.now();
  const cur = programs.find((p) => p.ChannelId === ch.Id && Date.parse(p.StartDate) <= now && Date.parse(p.EndDate) > now);
  return { ...ch, ServerId: SERVER_ID, UserData: { ...ud(ch.Id) }, CurrentProgram: cur ? progView(cur) : undefined };
}
['Le Journal de 13 h', 'Grand Format : la ville', 'Concert du samedi'].forEach((name, i) =>
  add({ Id: `rec-${i + 1}`, Name: name, Type: 'Recording', MediaType: 'Video', ChannelName: CHANNELS[i].Name, RunTimeTicks: (30 + i * 30) * TICKS_MIN, ImageTags: { Primary: 'p' }, Overview: 'Enregistrement de test.', DateCreated: new Date(Date.now() - (i + 1) * 86400000).toISOString() }),
);

// Playlists and collections: entries keep their own id so one item can appear twice.
const lists = new Map();
let entrySeq = 0;
function makeList(id, name, type, members) {
  add({ Id: id, Name: name, Type: type, IsFolder: true, MediaType: type === 'Playlist' ? 'Video' : undefined, ParentId: type === 'Playlist' ? 'lib-playlists' : 'lib-collections', ImageTags: { Primary: 'p' }, ChildCount: members.length });
  lists.set(id, members.map((itemId) => ({ entryId: `e${++entrySeq}`, itemId })));
}
makeList('playlist-1', 'Soirée science-fiction', 'Playlist', ['movie-0', 'movie-x0', 'ep-1-1', 'movie-3']);
makeList('playlist-2', 'À revoir', 'Playlist', ['movie-2', 'movie-5']);
makeList('boxset-1', 'Saga Horizon', 'BoxSet', ['movie-x0', 'movie-x8', 'movie-x16', 'movie-x24']);
makeList('boxset-2', 'Fantastique nordique', 'BoxSet', ['movie-6', 'movie-7']);
const syncCount = (id) => (items.get(id).ChildCount = lists.get(id).length);

// MOCK_DATASET=demo: the Blender open movies with their CC BY artwork (README screenshots). See demo/INTEGRATION.md.
const demo = process.env.MOCK_DATASET === 'demo' ? await import('./demo/demo-dataset.mjs') : null;
demo?.apply({ items, ud, lists, streams, VIDEO_OVERRIDES, VERSIONS, TRAILERS, programs, COMICS });
// A small music library (music-fixture.mjs, silent tracks): with the demo dataset, or MOCK_MUSIC=1.
if (demo || process.env.MOCK_MUSIC === '1') {
  addMusic({ add, makeList, ud });
  items.get('playlist-music').MediaType = 'Audio';
}
// MOCK_EXTRA_LIBS=1: empty views of every other CollectionType, plus more film and series libraries, so the
// desktop sidebar shows each of its groups and a long list (sidebar redesign screenshots). Invented names.
if (process.env.MOCK_EXTRA_LIBS === '1') {
  for (const [id, Name, CollectionType] of [
    ['classics', 'Classics', 'movies'],
    ['uhd', '4K', 'movies'],
    ['kids', 'Kids Shows', 'tvshows'],
    ['docs', 'Documentary', 'mixed'],
    ['concerts', 'Concerts', 'musicvideos'],
    ['audiobooks', 'Audiobooks', 'audiobooks'],
    ['games', 'Games', 'games'],
  ])
    add({ Id: `lib-x-${id}`, Name, Type: 'CollectionFolder', CollectionType, IsFolder: true, ImageTags: { Primary: 't' } });
}
// Photo libraries (photos-fixture.mjs, generated; MOCK_PHOTOS=0 leaves them out).
addPhotos({ add, ud });
countAlbums(items);

// MOCK_LIVETV=iptv: the IPTV-scale Live TV of mock-livetv.mjs (300 channels × 7 days, tuner pool, /Mock/LiveTv/*)
// answers before the 30-channel block below. mock-jellyfin.mjs calls liveTv({flavour: 'jellyfin', …}) first.
const ltModule = process.env.MOCK_LIVETV === 'iptv' ? await import('./mock-livetv.mjs') : null;
let lt = null;
// Live TV events go out on this mock's own /embywebsocket (store.broadcast); mock-jellyfin.mjs passes its own emit.
export function liveTv(opts = {}) {
  lt ??= ltModule?.createLiveTv({ flavour: 'emby', user: USER, emit: (type, data) => store.broadcast(type, data), ...opts, host: { items, ud, view, authed, serverId: opts.serverId ?? SERVER_ID, userId: opts.userId ?? USER.Id, video: VIDEO } }) ?? null;
  return lt;
}

// Remote control through the Sessions API (sessions.mjs): one session per sign-in.
const store = createSessions({ flavour: 'emby', serverId: SERVER_ID, userId: USER.Id, userName: USER.Name, items, log: (...a) => hooks.log(...a) });

async function extraRoutes(req, res, p, parts, q) {
  if (liveTv() && (await lt.route(req, res, p, parts, q))) return true;
  const M = req.method;
  // Channel logos: a wordmark on transparent so it reads like a broadcaster logo.
  if (parts[0] === 'Items' && parts[1]?.startsWith('ch-') && parts[2] === 'Images') {
    const t = (items.get(parts[1])?.Name ?? '').toUpperCase();
    const size = Math.min(64, Math.round(900 / Math.max(6, t.length)));
    send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200"><text x="240" y="125" text-anchor="middle" font-family="Bahnschrift, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#f2f2f5">${t}</text></svg>`, 'image/svg+xml');
    return true;
  }
  const mine =
    ['LiveTv', 'Playlists', 'Collections', 'LiveStreams'].includes(parts[0]) ||
    (parts[0] === 'Items' && parts[1]?.startsWith('ch-') && parts[2] === 'PlaybackInfo') ||
    (parts[0] === 'Users' && (parts[2] === 'Views' || (parts[2] === 'Items' && !parts[3] && lists.has(q.get('ParentId') ?? ''))));
  if (!mine) return false;
  const reply = (status, b) => (send(res, status, b), true);
  if (!authed(req, q)) return reply(401, 'Unauthorized');
  const listItems = (id) => (lists.get(id) ?? []).map((e) => ({ ...view(items.get(e.itemId)), PlaylistItemId: e.entryId }));

  if (parts[2] === 'Views') return reply(200, list([...items.values()].filter((x) => x.Type === 'CollectionFolder'), q));
  if (parts[0] === 'Users') {
    const arr = listItems(q.get('ParentId'));
    return reply(200, { Items: arr, TotalRecordCount: arr.length });
  }

  // Live TV
  if (p === '/LiveTv/Info') return reply(200, { IsEnabled: !NO_LIVETV, EnabledUsers: [USER.Id], Services: [{ Name: 'Mock Tuner', Status: 'Ok' }] });
  if (p === '/LiveTv/Channels') {
    const start = Number(q.get('StartIndex') ?? 0);
    const arr = CHANNELS.slice(start, start + Number(q.get('Limit') ?? 1000)).map(chanView);
    return reply(200, { Items: arr, TotalRecordCount: CHANNELS.length });
  }
  if (p === '/LiveTv/Programs' || p === '/LiveTv/Programs/Recommended') {
    const ids = q.get('ChannelIds')?.split(',');
    const minEnd = Date.parse(q.get('MinEndDate') ?? '') || -Infinity;
    const maxStart = Date.parse(q.get('MaxStartDate') ?? '') || Infinity;
    const now = Date.now();
    let arr = programs.filter((x) => (!ids || ids.includes(x.ChannelId)) && Date.parse(x.EndDate) > minEnd && Date.parse(x.StartDate) < maxStart);
    if (q.get('IsAiring') === 'true') arr = arr.filter((x) => Date.parse(x.StartDate) <= now && Date.parse(x.EndDate) > now);
    arr = arr.slice(0, Number(q.get('Limit') ?? 100000)).map(progView);
    return reply(200, { Items: arr, TotalRecordCount: arr.length });
  }
  if (parts[1] === 'Programs' && parts[2]) {
    const prog = progById.get(parts[2]);
    return prog ? reply(200, progView(prog)) : reply(404, 'Not found');
  }
  if (p === '/LiveTv/Recordings') return reply(200, list([...items.values()].filter((x) => x.Type === 'Recording'), q));
  if (p === '/LiveTv/Timers/Defaults') {
    const prog = progById.get(q.get('ProgramId'));
    if (!prog) return reply(404, 'Not found');
    return reply(200, { ProgramId: prog.Id, ChannelId: prog.ChannelId, StartDate: prog.StartDate, EndDate: prog.EndDate, PrePaddingSeconds: 60, PostPaddingSeconds: 300, RecordAnyChannel: false, RecordNewOnly: true, KeepUpTo: 0, Days: [] });
  }
  if (parts[1] === 'Timers' || parts[1] === 'SeriesTimers') {
    const store = parts[1] === 'Timers' ? timers : seriesTimers;
    if (M === 'GET' && !parts[2]) return reply(200, { Items: [...store.values()], TotalRecordCount: store.size });
    if (M === 'POST' && !parts[2]) {
      const b = await body(req);
      const prog = progById.get(b.ProgramId);
      if (!prog) return reply(400, 'Unknown program');
      const id = `${parts[1] === 'Timers' ? 'timer' : 'stimer'}-${randomUUID().slice(0, 8)}`;
      store.set(id, { Id: id, ProgramId: prog.Id, ChannelId: prog.ChannelId, ChannelName: prog.ChannelName, Name: prog.Name, StartDate: prog.StartDate, EndDate: prog.EndDate, Status: 'New', SeriesId: prog.SeriesId, RecordAnyChannel: b.RecordAnyChannel, RecordNewOnly: b.RecordNewOnly });
      return reply(204);
    }
    if (parts[2] && (M === 'DELETE' || parts[3] === 'Delete')) {
      store.delete(parts[2]);
      return reply(204);
    }
  }
  if (p === '/LiveStreams/Open') {
    const id = q.get('ItemId');
    return reply(200, { MediaSource: { ...mediaSource(id), Id: `live-${id}`, LiveStreamId: `ls-${randomUUID().slice(0, 8)}`, RequiresOpening: false, RunTimeTicks: undefined } });
  }
  if (parts[0] === 'LiveStreams') return reply(204);
  if (parts[2] === 'PlaybackInfo') {
    return reply(200, {
      MediaSources: [{ ...mediaSource(parts[1]), Id: `live-${parts[1]}`, RequiresOpening: true, OpenToken: `tok-${parts[1]}`, RunTimeTicks: undefined }],
      PlaySessionId: randomUUID().replace(/-/g, ''),
    });
  }

  // Playlists and collections
  const kind = parts[0] === 'Playlists' ? 'Playlist' : 'BoxSet';
  if (!parts[1] && M === 'POST') {
    const b = await body(req);
    const id = `${kind === 'Playlist' ? 'playlist' : 'boxset'}-${randomUUID().slice(0, 8)}`;
    const ids = (q.get('Ids') ?? (Array.isArray(b.Ids) ? b.Ids.join(',') : '')).split(',').filter(Boolean);
    makeList(id, q.get('Name') ?? b.Name ?? 'Sans titre', kind, ids);
    // An audio playlist stays one (music "save the queue as a playlist").
    if (kind === 'Playlist' && (q.get('MediaType') ?? b.MediaType) === 'Audio') items.get(id).MediaType = 'Audio';
    return reply(200, { Id: id });
  }
  const id = parts[1];
  if (!lists.has(id)) return reply(404, 'Not found');
  if (parts[2] === 'Items' && parts[4] === 'Move' && M === 'POST') {
    const arr = lists.get(id);
    const from = arr.findIndex((e) => e.entryId === parts[3]);
    if (from < 0) return reply(404, 'Not found');
    const [e] = arr.splice(from, 1);
    arr.splice(Math.min(arr.length, Number(parts[5])), 0, e);
    return reply(204);
  }
  if (parts[2] === 'Items' && M === 'GET') {
    const arr = listItems(id);
    return reply(200, { Items: arr, TotalRecordCount: arr.length });
  }
  if (parts[2] === 'Items' && M === 'POST' && !parts[3]) {
    for (const itemId of (q.get('Ids') ?? '').split(',').filter((x) => items.has(x))) lists.get(id).push({ entryId: `e${++entrySeq}`, itemId });
    syncCount(id);
    return reply(204);
  }
  if (parts[2] === 'Items' && (M === 'DELETE' || parts[3] === 'Delete')) {
    const drop = new Set((q.get('EntryIds') ?? q.get('Ids') ?? '').split(','));
    lists.set(id, lists.get(id).filter((e) => !drop.has(e.entryId) && !(kind === 'BoxSet' && drop.has(e.itemId))));
    syncCount(id);
    return reply(204);
  }
  return reply(404, 'Not found');
}

let adminMods;
async function adminModules() {
  if (adminMods) return adminMods;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-admin');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort() : [];
  adminMods = await Promise.all(files.map((f) => import(pathToFileURL(path.join(dir, f)).href)));
  return adminMods;
}

export async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;
  if (req.method === 'OPTIONS') return preflight(req, res);
  hooks.log(req.method, url.pathname + url.search);
  if (/^\/mock\/livetv(\/|$)/i.test(url.pathname) && liveTv()) return lt.control(req, res, url.pathname, q);
  const mp = url.pathname.replace(/^\/emby(?=\/)/i, '').split('/').filter(Boolean);
  if (url.pathname === '/mock/lrclib/api/get' && req.method === 'GET') return lrclibRoute({ req, res, q, items, send });
  if (mp[0] === 'Mock' && mp[1] === 'State' && req.method === 'GET') return send(res, 200, { ...store.state(), music: MUSIC_LOG });
  if (mp[0] === 'Mock' && mp[1] === 'AccessSchedules' && req.method === 'POST') {
    const list = await body(req);
    if (!Array.isArray(list)) return send(res, 400, 'Expected a JSON array of AccessSchedules', 'text/plain');
    const id = q.get('userId') ?? USER.Id;
    let pol = id === USER.Id ? USER.Policy : null;
    for (const m of await adminModules()) if (m.policyOf) pol = m.policyOf(USER, id);
    if (!pol) return send(res, 404, 'User not found', 'text/plain');
    pol.AccessSchedules = list;
    return send(res, 200, { AccessSchedules: list });
  }
  if (mp[0] === 'Mock' && mp[1] === 'Stream' && mp[2] === 'Fail') {
    const mode = q.get('mode') ?? 'none';
    if (!['none', '503', 'drop'].includes(mode)) return send(res, 400, 'mode: none, 503 or drop', 'text/plain');
    streamFail = { mode, count: Number(q.get('count') ?? 1), after: Number(q.get('after') ?? 65536) };
    return send(res, 200, streamFail);
  }
  if (mp[0] === 'Mock' && mp[1] === 'Down') {
    serverDown = q.get('on') !== '0';
    return send(res, 200, { down: serverDown });
  }
  if (serverDown && mp[0] !== 'Mock') return send(res, 503, 'Service Unavailable', 'text/plain');
  if (mp[0] === 'Mock' && mp[1] === 'Sessions' && req.method === 'POST') {
    if (mp.length === 2) return send(res, 200, store.addVirtual(await body(req)));
    if (mp.length === 4) return send(res, store.drive(mp[2], mp[3], q));
  }
  if (!url.pathname.toLowerCase().startsWith('/emby/')) return send(res, 404, 'Not found', 'text/plain');
  const p = url.pathname.slice(5);
  const parts = p.split('/').filter(Boolean);
  // As Emby 4.10 (checked on a real 4.10.1): a name repeated in the query (any case) is one value joined with commas, so
  // a repeated number ("ImageTypeLimit=1&ImageTypeLimit=1") fails to parse: 500. Jellyfin (ASP.NET Core) takes the first.
  if (req.headers['x-mock-flavour'] !== 'jellyfin') {
    const named = new Map();
    for (const [k, v] of q) named.set(k.toLowerCase(), [...(named.get(k.toLowerCase()) ?? []), v]);
    const bad = [...named.values()].find((vs) => vs.length > 1 && vs.every((v) => /^-?\d+$/.test(v)));
    if (bad) return send(res, 500, `The input string '${bad.join(',')}' was not in a correct format.`, 'text/plain');
  }
  // TP-11: outside the hours of the token's user (sign-in: below, once the password is checked). Images stay public.
  const caller = authed(req, q) ? tokenUser.get(tokenOf(req, q)) : null;
  if (caller && !parts.includes('Images') && !(await allowedNow(caller))) return send(res, 401, 'This user account is not allowed access at this time.', 'text/plain');
  // A report feeds the session store here, before the Live TV module (MOCK_LIVETV) may answer it; the body is
  // buffered and replayed so whoever answers can still read it.
  if (req.method === 'POST' && /^\/Sessions\/Playing(\/Progress|\/Stopped)?$/i.test(p) && authed(req, q)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    req[Symbol.asyncIterator] = async function* () {
      yield raw;
    };
    let b = {};
    try {
      b = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      // Not JSON: nothing to record.
    }
    store.report(store.forToken(tokenOf(req, q)), (parts[2] ?? 'start').toLowerCase(), b);
    logReport(items, (parts[2] ?? 'start').toLowerCase(), b);
  }
  if (await extraRoutes(req, res, p, parts, q)) return;
  // Admin endpoints live in tools/mock-server/mock-admin/*.mjs, one module per area: export async function route(ctx) -> boolean.
  for (const mod of await adminModules()) if (await mod.route({ req, res, p, parts, q, send, body, tokens, USER, SERVER_ID, items, addedSubs, remote: store })) return;

  if (p === '/System/Info/Public') return send(res, 200, { Id: SERVER_ID, ServerName: SERVER_NAME, Version: '4.9.1.0', LocalAddress: `http://127.0.0.1:${PORT}` });
  if (p === '/Users/Public') return send(res, 200, [USER, ...PROFILES]);
  if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
    const b = await body(req);
    const who = b.Username?.toLowerCase() === 'wika' && b.Pw === 'wicaby' ? USER : profileFor(b.Username, b.Pw ?? '');
    if (!who) return send(res, 401, 'Invalid user or password', 'text/plain');
    if (!(await allowedNow(who.Id))) return send(res, 401, 'User is not allowed access at this time.', 'text/plain');
    const token = randomUUID().replace(/-/g, '');
    tokens.add(token);
    tokenUser.set(token, who.Id);
    const f = authFields(req);
    const s = store.login(token, { Client: f.Client ?? 'Unknown', Device: f.Device ?? 'Unknown', DeviceId: f.DeviceId ?? token, Version: f.Version ?? '0' });
    return send(res, 200, { AccessToken: token, ServerId: SERVER_ID, User: who, SessionInfo: { Id: s.Id, UserId: who.Id, UserName: who.Name, Client: s.Client, DeviceId: s.DeviceId, DeviceName: s.DeviceName } });
  }
  if (photoRoute({ req, res, parts, q, items, authed: authed(req, q), flavour: req.headers['x-mock-flavour'] === 'jellyfin' ? 'jellyfin' : 'emby', send })) return;
  if (parts[0] === 'Items' && parts[2] === 'Images' && parts[3] === 'Chapter') return send(res, 200, chapterSvg(Number(parts[4] ?? 0)), 'image/svg+xml');
  if (parts[0] === 'Items' && parts[2] === 'Images') {
    if (demo?.serveImage(res, parts[1], parts[3])) return;
    const w = Number(q.get('maxWidth') ?? 400);
    const h = Number(q.get('maxHeight') ?? 600);
    return send(res, 200, svg(parts[1], parts[3], Math.max(200, Math.round((h * 2) / 3) || w), Math.max(300, h)), 'image/svg+xml');
  }
  if (parts[0] === 'Users' && parts[2] === 'Images') return send(res, 404, '', 'text/plain');
  // X-02: the next PlaybackInfo answers 500 (a failed quality switch keeps the old stream).
  if (p === '/Mock/PlaybackInfo/FailNext') {
    pbiFailNext = true;
    return send(res, 200, { ok: true });
  }
  if (!authed(req, q)) return send(res, 401, 'Unauthorized', 'text/plain');

  if (parts[0] === 'Items' && (parts[2] === 'File' || parts[2] === 'Download') && COMICS[parts[1]]) {
    const data = cbz(parts[1]);
    // Range requests as both servers serve files (comic covers read the end, then one entry; PDF pages read pieces).
    // CORS as on every other answer: the TV web reader fetches the book from the page.
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (r && (r[1] || r[2])) {
      const start = r[1] ? Number(r[1]) : Math.max(0, data.length - Number(r[2]));
      const end = r[1] && r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}`, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      res.writeHead(206, { 'Content-Type': 'application/zip', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
    return res.end(data);
  }
  if (parts[0] === 'Videos' && parts[2] === 'index.bif' && items.has(parts[1])) {
    if (!q.get('Width')) return send(res, 400, 'Width is required', 'text/plain');
    const data = bifFor(parts[1]);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
    return res.end(data);
  }
  // Jellyfin MediaSegments (Wicaby only asks Jellyfin servers; served here for completeness).
  if (parts[0] === 'MediaSegments' && items.has(parts[1])) {
    const span = MARKER_SPAN || items.get(parts[1]).RunTimeTicks || 0;
    const seg = (Type, a, b) => ({ Id: `${parts[1]}-${Type}`, ItemId: parts[1], Type, StartTicks: Math.round(span * a), EndTicks: Math.round(span * b) });
    const all = [seg('Recap', 0, 0.04), seg('Intro', 0.05, 0.2), seg('Commercial', 0.5, 0.53), seg('Preview', 0.8, 0.85), seg('Outro', 0.85, 1)];
    return send(res, 200, { Items: all, TotalRecordCount: all.length, StartIndex: 0 });
  }
  // X-03: a downloaded subtitle's file (two cues).
  if (parts[0] === 'Videos' && parts[3] === 'Subtitles' && /^Stream\.(srt|vtt)$/.test(parts.at(-1))) {
    const vtt = parts.at(-1).endsWith('vtt');
    const sep = vtt ? '.' : ',';
    const cue = (n, a, b, text) => `${vtt ? '' : `${n}\n`}00:00:${a}${sep}000 --> 00:00:${b}${sep}000\n${text}\n`;
    const text = `${vtt ? 'WEBVTT\n\n' : ''}${cue(1, '01', '04', 'Sous-titre téléchargé')}\n${cue(2, '05', '09', 'Wicaby')}`;
    if (req.headers['x-mock-flavour'] === 'jellyfin') return send(res, 200, text, vtt ? 'text/vtt' : 'application/x-subrip');
    // Cast spec CA-06 AC6: Emby CORS on Stream.vtt is unverified, so Emby is modelled WITHOUT it (the relay adds it).
    res.writeHead(200, { 'Content-Type': vtt ? 'text/vtt' : 'application/x-subrip' });
    return res.end(text);
  }
  // Cast spec CA-09: an HLS remux (the Chromecast profile). Playlists only: nothing decodes the segments here.
  if (parts[0] === 'Videos' && parts.length === 3 && /^(master|main)\.m3u8$/.test(parts[2])) {
    const runSec = Math.round((items.get(parts[1])?.RunTimeTicks ?? 6e10) / 1e7);
    const text =
      parts[2] === 'master.m3u8'
        ? `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.640028,mp4a.40.2"\nmain.m3u8?${new URLSearchParams(q).toString()}\n`
        : `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nhls1/main/0.ts\n#EXTINF:${Math.max(1, runSec - 6)}.0,\nhls1/main/1.ts\n#EXT-X-ENDLIST\n`;
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(text);
  }
  // Streams
  // Music (music-fixture.mjs): silent streams, lyrics, genres, instant mix, artists.
  if (musicRoute({ req, res, p, parts, q, items, list, send, log: hooks.log })) return;
  if ((parts[0] === 'Videos' || parts[0] === 'Items') && (parts[2] === 'stream' || parts[2]?.startsWith('stream.') || parts[2] === 'Download')) {
    // The VC-1 trailer's own file on a direct play; the server's conversion (not static) is the normal video below.
    if (parts[1] === 'trailer-6' && /^true$/i.test(q.get('static') ?? q.get('Static') ?? '')) {
      vc1File ??= vc1Trailer(30);
      hooks.log('Stream VC-1 trailer', p);
      res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': vc1File.length });
      return res.end(vc1File);
    }
    if (!VIDEO || !fs.existsSync(VIDEO)) return send(res, 404, 'No test video configured', 'text/plain');
    if (streamFail.mode !== 'none' && streamFail.count > 0) {
      const { mode, after } = streamFail;
      if (--streamFail.count <= 0) streamFail = { mode: 'none', count: 0, after: 0 };
      hooks.log('StreamFail', mode, p);
      if (mode === '503') return send(res, 503, 'Service Unavailable', 'text/plain');
      // drop: headers and the first bytes, then the connection goes away mid-stream.
      const size = fs.statSync(VIDEO).size;
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      const head = Buffer.alloc(Math.max(0, Math.min(after, size - start)));
      const fd = fs.openSync(VIDEO, 'r');
      fs.readSync(fd, head, 0, head.length, start);
      fs.closeSync(fd);
      res.writeHead(start ? 206 : 200, { 'Content-Type': 'video/x-matroska', 'Content-Length': size - start, ...(start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) });
      return res.write(head, () => res.destroy());
    }
    const size = fs.statSync(VIDEO).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', ...STREAM_CORS });
      return fs.createReadStream(VIDEO, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': size, 'Accept-Ranges': 'bytes', ...STREAM_CORS });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(VIDEO).pipe(res);
  }

  // Playing an item again dates it and brings it back into Resume (X-01 HideFromResume).
  if (req.method === 'POST' && /^\/Sessions\/Playing(\/Progress|\/Stopped)?$/.test(p)) {
    const b = await body(req).catch(() => ({}));
    if (b?.ItemId && items.has(b.ItemId)) Object.assign(ud(b.ItemId), { LastPlayedDate: new Date().toISOString(), HideFromResume: false });
    // MOCK_KEEP_POSITION=1: the reported position is kept, as a real server does, so Resume follows what was played.
    if (process.env.MOCK_KEEP_POSITION === '1' && b?.ItemId && items.has(b.ItemId) && b.PositionTicks > 0) ud(b.ItemId).PlaybackPositionTicks = b.PositionTicks;
    hooks.log('Report', p.split('/')[3] ?? 'Start', b?.ItemId, 'MediaSourceId=' + b?.MediaSourceId, 'PlaySessionId=' + b?.PlaySessionId, 'PlayMethod=' + b?.PlayMethod);
    return send(res, 204);
  }
  if (p === '/Videos/ActiveEncodings') hooks.log('ActiveEncodings', req.method, 'PlaySessionId=' + q.get('PlaySessionId'));
  if (parts[0] === 'Sessions') {
    const session = store.forToken(tokenOf(req, q));
    if (p === '/Sessions/Logout') store.logout(tokenOf(req, q));
    if (p === '/Sessions/Capabilities/Full' && req.method === 'POST' && session) store.capabilities(session, await body(req));
    if (parts.length >= 3 && req.method === 'POST') {
      const r = store.command(parts[1], parts.slice(2), q, await body(req), USER.Id);
      if (r) return r.status === 204 ? send(res, 204) : send(res, r.status, r.text, 'text/plain');
    }
  }
  if (p.startsWith('/Sessions') || p === '/Videos/ActiveEncodings') return send(res, 204);
  if (p === '/Genres') {
    const names = [...new Set([...items.values()].flatMap((x) => x.Genres ?? []))].sort((a, b) => a.localeCompare(b));
    return send(res, 200, { Items: names.map((Name) => ({ Name, Id: `genre-${Name}` })), TotalRecordCount: names.length });
  }
  if (p === '/System/WakeOnLanInfo') return send(res, 200, []);
  if (parts[0] === 'Items' && parts[2] === 'PlaybackInfo') {
    // The version asked for (query or body MediaSourceId), like Emby.
    const b = req.method === 'POST' ? await body(req) : {};
    const want = q.get('MediaSourceId') ?? b.MediaSourceId;
    const all = sourcesFor(parts[1]);
    hooks.log('PlaybackInfo', parts[1], 'MediaSourceId=' + want, 'Audio=' + (q.get('AudioStreamIndex') ?? b.AudioStreamIndex), 'Subtitle=' + (q.get('SubtitleStreamIndex') ?? b.SubtitleStreamIndex), 'Body=' + JSON.stringify({ ...b, DeviceProfile: undefined }));
    if (pbiFailNext) {
      pbiFailNext = false;
      return send(res, 500, 'mock failure', 'text/plain');
    }
    // X-02: MaxStreamingBitrate below the source, or direct play refused, gets a transcode (the same
    // file, so mpv can play it); PlayMethod then reads Transcode (no videocodec=copy).
    const src = all.find((s) => s.Id === want) ?? all[0];
    const max = Number(q.get('MaxStreamingBitrate') ?? b.MaxStreamingBitrate) || Infinity;
    const PlaySessionId = randomUUID().replace(/-/g, '');
    // Cast spec CA-09: the Chromecast profile (desktop castProfile) is honoured: a container it does not list (MKV)
    // is remuxed to HLS, as both servers do; every other profile keeps the bitrate-only rule below.
    // A song to a Cast or DLNA device (music casting): direct when the profile lists its container, else an MP3
    // transcode over plain HTTP, as both servers answer an audio TranscodingProfile.
    if (/^Wicaby (Cast|DLNA)/.test(String(b.DeviceProfile?.Name ?? '')) && isMusic(items.get(parts[1]))) {
      const listedAudio = (b.DeviceProfile?.DirectPlayProfiles ?? []).some((d) => d.Type === 'Audio' && String(d.Container).split(',').includes(src.Container));
      hooks.log('PlaybackInfo', parts[1], listedAudio ? 'Audio direct' : 'Audio transcode mp3 of', src.Container);
      if (listedAudio) return send(res, 200, { MediaSources: [src], PlaySessionId });
      const aq = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId, DeviceId: 'mock-transcode', AudioCodec: 'mp3', AudioBitrate: '320000' });
      return send(res, 200, { MediaSources: [{ ...src, SupportsDirectPlay: false, SupportsDirectStream: false, TranscodingSubProtocol: 'http', TranscodingContainer: 'mp3', TranscodingUrl: `/Audio/${parts[1]}/stream.mp3?${aq}` }], PlaySessionId });
    }
    const castDmr = String(b.DeviceProfile?.Name ?? '').startsWith('Wicaby Cast');
    const listed = (b.DeviceProfile?.DirectPlayProfiles ?? []).some((d) => d.Type === 'Video' && String(d.Container).split(',').includes(src.Container));
    if (castDmr && !listed) {
      hooks.log('PlaybackInfo', parts[1], 'Cast profile: HLS remux of', src.Container);
      const hq = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId, VideoCodec: 'h264', AudioCodec: 'aac', SegmentContainer: 'ts' });
      const startTicks = Number(b.StartTimeTicks ?? q.get('StartTimeTicks') ?? 0);
      if (startTicks > 0) hq.set('StartTimeTicks', String(startTicks));
      return send(res, 200, { MediaSources: [{ ...src, SupportsDirectPlay: false, SupportsDirectStream: false, TranscodingSubProtocol: 'hls', TranscodingContainer: 'ts', TranscodingUrl: `/Videos/${parts[1]}/master.m3u8?${hq}` }], PlaySessionId });
    }
    if ((src.Bitrate ?? 0) <= max && b.EnableDirectPlay !== false && q.get('EnableDirectPlay') !== 'false') return send(res, 200, { MediaSources: [src], PlaySessionId });
    const tq = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId, VideoCodec: 'h264', AudioCodec: 'aac', VideoBitrate: String(Math.min(max, src.Bitrate ?? max)) });
    // The subtitle asked for is burned in, as a server does when the client cannot take it on the side.
    const sub = Number(q.get('SubtitleStreamIndex') ?? b.SubtitleStreamIndex ?? -1);
    const MediaStreams = src.MediaStreams.map((st) => (st.Type === 'Subtitle' && st.Index === sub ? { ...st, DeliveryMethod: 'Encode' } : st));
    return send(res, 200, { MediaSources: [{ ...src, MediaStreams, SupportsDirectPlay: false, SupportsDirectStream: false, TranscodingSubProtocol: 'http', TranscodingContainer: 'mkv', TranscodingUrl: `/Videos/${parts[1]}/stream?${tq}` }], PlaySessionId });
  }
  if (parts[0] === 'Items' && parts[2] === 'Similar') return send(res, 200, list([...items.values()].filter((x) => x.Type === 'Movie' && x.Id !== parts[1]), q));
  if (parts[0] === 'Shows' && parts[1] === 'Upcoming') return send(res, 200, list([...items.values()].filter((x) => x.Type === 'Episode' && Date.parse(x.PremiereDate ?? '') > Date.now()), q));
  if (parts[0] === 'Shows' && parts[1] === 'NextUp') return send(res, 200, list([items.get('ep-1-3'), items.get('ep-2-1')].filter(Boolean), q));
  if (parts[0] === 'Shows' && parts[2] === 'Seasons') return send(res, 200, list([...items.values()].filter((x) => x.Type === 'Season' && x.SeriesId === parts[1]), q));
  if (parts[0] === 'Shows' && parts[2] === 'Episodes') {
    const season = q.get('SeasonId');
    let eps = [...items.values()].filter((x) => x.Type === 'Episode' && x.LocationType !== 'Virtual' && x.SeriesId === parts[1] && (!season || x.SeasonId === season));
    const from = eps.findIndex((x) => x.Id === q.get('StartItemId'));
    if (from >= 0) eps = eps.slice(from);
    return send(res, 200, list(eps, q));
  }

  if (parts[0] === 'Users' && (parts[1] === USER.Id || PROFILES.some((u) => u.Id === parts[1]))) {
    const rest = parts.slice(2);
    // A profile answers as itself (its name and avatar tag) with Wika's policy.
    if (rest.length === 0) return send(res, 200, { ...USER, ...PROFILES.find((u) => u.Id === parts[1]) });
    if (rest[0] === 'Views') return send(res, 200, list([items.get('lib-movies'), items.get('lib-shows'), items.get('lib-books')], q));
    if ((rest[0] === 'FavoriteItems' || rest[0] === 'PlayedItems') && rest[1]) {
      const d = ud(rest[1]);
      const on = req.method === 'POST';
      if (rest[0] === 'FavoriteItems') d.IsFavorite = on;
      else {
        d.Played = on;
        d.PlaybackPositionTicks = 0;
        // Both servers' MarkUnplayed clear the last play date: the item leaves the watch history (TP-08).
        d.LastPlayedDate = on ? new Date().toISOString() : null;
      }
      return send(res, 200, d);
    }
    if (rest[0] === 'Items') {
      if (rest[1] === 'Resume') {
        const resumable = [...items.values()].filter((x) => x.MediaType === 'Video' && !ud(x.Id).Played && ud(x.Id).PlaybackPositionTicks > 0);
        // Like Emby 4.9, Resume mixes in a row without a position (ep-2-1, also next up); hidden rows stay out.
        if (items.has('ep-2-1') && !resumable.includes(items.get('ep-2-1'))) resumable.push(items.get('ep-2-1'));
        resumable.sort((a, b) => (Date.parse(ud(b.Id).LastPlayedDate ?? '') || 0) - (Date.parse(ud(a.Id).LastPlayedDate ?? '') || 0));
        return send(res, 200, list(resumable.filter((x) => !ud(x.Id).HideFromResume), q));
      }
      if (rest[1] && rest[2] === 'HideFromResume' && req.method === 'POST') {
        ud(rest[1]).HideFromResume = q.get('Hide') === 'true';
        hooks.log('HideFromResume', rest[1], 'Hide=' + q.get('Hide'));
        return send(res, 200, ud(rest[1]));
      }
      if (rest[1] === 'Latest') {
        const parent = q.get('ParentId');
        // No ParentId: every library, newest first (the Android TV "Recently Added" channel).
        const arr = parent
          ? [...items.values()].filter((x) => x.ParentId === parent && !x.IsFolder || (parent === 'lib-shows' && x.Type === 'Series'))
          : [...items.values()].filter((x) => x.Type === 'Movie' || x.Type === 'Series').sort((a, b) => String(b.DateCreated ?? '').localeCompare(String(a.DateCreated ?? '')));
        return send(res, 200, arr.slice(0, Number(q.get('Limit') ?? 1000)).map(view));
      }
      if (rest[1] && rest[2] === 'LocalTrailers') return send(res, 200, (TRAILERS[rest[1]] ?? []).map((t) => view(items.get(t))));
      if (rest[1] && rest[2] === 'SpecialFeatures') return send(res, 200, (EXTRAS[rest[1]] ?? []).map((t) => view(items.get(t))));
      if (rest[1] && rest[2] === 'Intros') {
        const intro = rest[1] !== 'movie-3' && items.get(rest[1])?.Type === 'Movie' ? [view(items.get('trailer-3'))] : [];
        return send(res, 200, { Items: intro, TotalRecordCount: intro.length });
      }
      if (rest[1] && rest[2] === 'UserData') {
        Object.assign(ud(rest[1]), { LastPlayedDate: new Date().toISOString() }, await body(req));
        return send(res, 200, ud(rest[1]));
      }
      if (rest[1]) {
        const it = items.get(rest[1]);
        return it ? send(res, 200, view(it)) : send(res, 404, 'Not found', 'text/plain');
      }
      let arr = [...items.values()].filter((x) => x.LocationType !== 'Virtual');
      const parent = q.get('ParentId');
      const types = q.get('IncludeItemTypes')?.split(',');
      const term = q.get('SearchTerm')?.toLowerCase();
      const ids = q.get('Ids')?.split(',');
      if (ids) arr = arr.filter((x) => ids.includes(x.Id));
      if (parent) arr = arr.filter((x) => x.ParentId === parent || (q.get('Recursive') === 'true' && (x.SeriesId === parent || x.SeasonId === parent || items.get(x.SeriesId)?.ParentId === parent || under(x, parent))));
      const artists = q.get('ArtistIds')?.split(',');
      // Both servers: an album artist or an artist credited on the item.
      if (artists) arr = arr.filter((x) => [...(x.ArtistItems ?? []), ...(x.AlbumArtists ?? [])].some((a) => artists.includes(a.Id)));
      if (types) arr = arr.filter((x) => types.includes(x.Type));
      if (term) arr = arr.filter((x) => x.Name.toLowerCase().includes(term));
      if (q.get('Genres')) arr = arr.filter((x) => x.Genres?.includes(q.get('Genres')));
      arr = musicFilters(arr, q, ud);
      if (q.get('PersonIds')) arr = arr.filter((x) => x.People?.some((pp) => pp.Id === q.get('PersonIds')));
      if (q.get('Filters')?.includes('IsFavorite')) arr = arr.filter((x) => ud(x.Id).IsFavorite);
      if (q.get('Filters')?.includes('IsUnplayed')) arr = arr.filter((x) => !ud(x.Id).Played);
      if (q.get('Filters')?.includes('IsPlayed')) arr = arr.filter((x) => ud(x.Id).Played);
      if (q.get('Filters')?.includes('IsResumable')) arr = arr.filter((x) => (ud(x.Id).PlaybackPositionTicks ?? 0) > 0 && !ud(x.Id).Played);
      // Premiere date bounds, compared on the wall-clock fields as the servers store an EXIF date (photos "on this day").
      const wall = (v) => String(v ?? '').slice(0, 19);
      if (q.get('MinPremiereDate')) arr = arr.filter((x) => x.PremiereDate && wall(x.PremiereDate) >= wall(q.get('MinPremiereDate')));
      if (q.get('MaxPremiereDate')) arr = arr.filter((x) => x.PremiereDate && wall(x.PremiereDate) <= wall(q.get('MaxPremiereDate')));
      if (!types && !term && !ids && !parent) arr = arr.filter((x) => x.Type !== 'CollectionFolder' && x.Type !== 'Trailer' && !x.ExtraType);
      // The A-Z rail (Android TV LetterIndex): name bounds on SortName, compared like both servers' SQL (binary).
      for (const [k, keep] of [['NameLessThan', (n, v) => n < v], ['NameStartsWithOrGreater', (n, v) => n >= v], ['NameStartsWith', (n, v) => n.startsWith(v)]]) {
        const v = q.get(k)?.toLowerCase();
        if (v) arr = arr.filter((x) => keep(sortNameOf(x), v));
      }
      const sort = q.get('SortBy') ?? 'SortName';
      if (sort.startsWith('SortName')) arr.sort((a, b) => (sortNameOf(a) < sortNameOf(b) ? -1 : sortNameOf(a) > sortNameOf(b) ? 1 : 0));
      // Album order: by album, then disc and track number.
      if (sort.startsWith('Album') || sort.startsWith('ParentIndexNumber')) arr.sort((a, b) => (a.Album ?? '').localeCompare(b.Album ?? '') || (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
      // Dates, then name (photo timelines: SortBy=DateCreated,SortName).
      const dateKey = /^(DateCreated|PremiereDate)/.exec(sort)?.[1];
      if (dateKey) arr.sort((a, b) => (a[dateKey] ?? '') < (b[dateKey] ?? '') ? -1 : (a[dateKey] ?? '') > (b[dateKey] ?? '') ? 1 : a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
      if (sort.startsWith('ProductionYear')) arr.sort((a, b) => (a.ProductionYear ?? 0) - (b.ProductionYear ?? 0));
      if (sort.startsWith('CommunityRating')) arr.sort((a, b) => (a.CommunityRating ?? 0) - (b.CommunityRating ?? 0));
      // Never played sorts as the NEWEST date, as a real Emby 4.10 answered (History showed nothing): only a
      // Filters=IsPlayed / IsResumable query is guaranteed to list played items first.
      if (sort.startsWith('DatePlayed')) arr.sort((a, b) => (Date.parse(ud(a.Id).LastPlayedDate ?? '') || Infinity) - (Date.parse(ud(b.Id).LastPlayedDate ?? '') || Infinity));
      if (q.get('SortOrder') === 'Descending') arr.reverse();
      // Folders first, as both servers' IsFolder comparer (stable: keeps the order above).
      if (sort.startsWith('IsFolder')) arr.sort((a, b) => Number(Boolean(b.IsFolder)) - Number(Boolean(a.IsFolder)));
      return send(res, 200, list(arr, q));
    }
  }
  return send(res, 404, 'Not found', 'text/plain');
}

export { items, ud, view, list, svg, send, preflight, body, chapterSvg, mediaSource, tokens, USER, SERVER_ID, MARKER_SPAN, TICKS_MIN, COMICS, cbz, PORT, VIDEO };

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const server = http.createServer(handler);
  liveTv();
  // /embywebsocket: remote control, Sessions pushes and, with MOCK_LIVETV=iptv, the Live TV events.
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    if (!/^(\/emby)?\/embywebsocket\/?$/i.test(url.pathname)) return sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    const session = store.forToken(tokenOf(req, url.searchParams));
    if (!session) return sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    store.attach(req, sock, session);
  });
  // Loopback only (MOCK_HOST widens it): a mock reachable from the LAN would show up in real clients.
  server.listen(PORT, process.env.MOCK_HOST || '127.0.0.1', () => console.log(`Mock Emby on http://127.0.0.1:${PORT} (user Wika / wicaby)${VIDEO ? `, video ${VIDEO}` : ''}`));
}
