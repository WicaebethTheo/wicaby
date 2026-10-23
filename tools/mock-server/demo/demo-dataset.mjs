// Demo catalogue for the mock servers (MOCK_DATASET=demo): the Blender Foundation open movies with
// their real CC BY artwork, for README screenshots. No copyrighted posters, no real server.
//
// It rewrites the catalogue mock-emby.mjs has just built, in place, and keeps the ids the mock
// hard-codes (movie-0..movie-11, series-1, season-1, ep-1-1..ep-1-3, trailer-0, trailer-3,
// playlist-1/2, boxset-1/2), so Resume, Next Up, versions, trailers, cinema intros, playlists and
// the Jellyfin mock keep working unchanged. Everything else in the movie/show libraries (the 48
// generated filler films, season 2, the fictional cast) is removed. Comics, Live TV channels,
// programmes and recordings keep their ids and are only renamed (English by default). The admin
// pages read ADMIN (below) through admin-demo.mjs for their titles, paths and log lines.
//
// Images: files next to this module, listed in ATTRIBUTION.json (built by scripts/build-demo-assets.mjs).
// Image tags are the files' content hashes, BlurHashes are the real ones.
//
// MOCK_DEMO_LANG=fr switches titles of libraries/lists, overviews, genres, comics and Live TV to French
// (default: en).
// Cast and crew come from the films' credits (studio.blender.org /projects/<slug>/pages/credits/ and the
// films' own end credits); the Glass Half voices (Ryan Millar as Max, Trista Mrema as Min) are on its
// Studio credits page.
// Community ratings below are illustrative values for the demo, not scores from any site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LANG = (process.env.MOCK_DEMO_LANG ?? 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
const t = (en, fr) => (LANG === 'fr' ? fr : en);

const attributionFile = path.join(DIR, 'ATTRIBUTION.json');
if (!fs.existsSync(attributionFile)) throw new Error(`Demo dataset: ${attributionFile} is missing; run node scripts/build-demo-assets.mjs first.`);
const ATTRIBUTION = JSON.parse(fs.readFileSync(attributionFile, 'utf8'));

// film slug -> { poster, backdrop, 'episode-1'... } -> { file, tag, blurHash }
const art = {};
for (const img of ATTRIBUTION.images) {
  (art[img.film] ??= {})[img.role] = { file: path.join(DIR, img.file), tag: img.sha256.slice(0, 16), blurHash: img.blurHash };
}

const TICKS_PER_SECOND = 10_000_000;
const secs = (m, s = 0) => (m * 60 + s) * TICKS_PER_SECOND;
const day = 86_400_000;

const G = {
  animation: t('Animation', 'Animation'),
  comedy: t('Comedy', 'Comédie'),
  fantasy: t('Fantasy', 'Fantastique'),
  scifi: t('Science Fiction', 'Science-fiction'),
  action: t('Action', 'Action'),
  adventure: t('Adventure', 'Aventure'),
  drama: t('Drama', 'Drame'),
  horror: t('Horror', 'Horreur'),
  family: t('Family', 'Familial'),
};
// US-style ratings in English, French classification in French.
const R = { G: t('G', 'TP'), PG: t('PG', 'TP'), PG13: t('PG-13', '12') };

const person = (name, type = 'Director', role) => ({ Id: `person-${name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '-')}`, Name: name, Type: type, Role: role ?? (type === 'Director' ? t('Director', 'Réalisation') : undefined) });

// One entry per mock id. Order of DateCreated drives the "Latest" rows: newest first.
export const MOVIES = [
  {
    id: 'movie-0', slug: 'big-buck-bunny', name: 'Big Buck Bunny', year: 2008, runtime: secs(9, 56), rating: R.G, score: 6.9,
    genres: [G.animation, G.comedy, G.family],
    overview: t(
      'A big, gentle rabbit enjoys a quiet day in the meadow until three bullying rodents go one prank too far. Time for a carefully engineered revenge.',
      'Un gros lapin paisible profite de sa journée dans la prairie, jusqu’à ce que trois rongeurs farceurs aillent trop loin. L’heure d’une vengeance minutieusement préparée a sonné.',
    ),
    tagline: t('The big buck is back.', 'Le grand lapin contre-attaque.'),
    people: [person('Sacha Goedegebure')],
  },
  {
    id: 'movie-1', slug: 'elephants-dream', name: 'Elephants Dream', year: 2006, runtime: secs(10, 54), rating: R.PG, score: 6.1,
    genres: [G.animation, G.scifi],
    overview: t(
      'Deep inside an endless, humming machine, old Proog guides the young Emo through a world only he seems to understand. The first open movie, made entirely with open-source tools.',
      'Au cœur d’une machine sans fin, le vieux Proog guide le jeune Emo dans un monde que lui seul semble comprendre. Le tout premier film libre, réalisé uniquement avec des outils open source.',
    ),
    people: [person('Bassam Kurdali'), person('Tygo Gernandt', 'Actor', 'Proog'), person('Cas Jansen', 'Actor', 'Emo')],
  },
  {
    id: 'movie-2', slug: 'sintel', name: 'Sintel', year: 2010, runtime: secs(14, 48), rating: R.PG13, score: 7.5,
    genres: [G.animation, G.fantasy, G.adventure],
    overview: t(
      'A lonely young woman searches the frozen highlands and the desert city for the baby dragon she once rescued and raised, never imagining what the journey will cost her.',
      'Une jeune femme solitaire parcourt les montagnes gelées et la cité du désert à la recherche du bébé dragon qu’elle avait sauvé, sans imaginer ce que ce voyage va lui coûter.',
    ),
    tagline: t('Some journeys never end.', 'Certains voyages ne finissent jamais.'),
    people: [person('Colin Levy'), person('Halina Reijn', 'Actor', 'Sintel'), person('Thom Hoffman', 'Actor', t('Shaman', 'Chaman'))],
  },
  {
    id: 'movie-3', slug: 'tears-of-steel', name: 'Tears of Steel', year: 2012, runtime: secs(12, 14), rating: R.PG13, score: 6.3,
    genres: [G.scifi, G.action],
    overview: t(
      'In a future Amsterdam overrun by giant robots, a group of warriors and scientists stage a desperate gamble: replay the moment a broken relationship sent the world into chaos.',
      'Dans un Amsterdam futuriste envahi par des robots géants, des soldats et des scientifiques tentent un pari désespéré : rejouer l’instant où une rupture a plongé le monde dans le chaos.',
    ),
    people: [person('Ian Hubert'), person('Derek de Lint', 'Actor', 'Old Thom'), person('Sergio Hasselbaink', 'Actor', 'Barley'), person('Vanja Rukavina', 'Actor', 'Celia')],
  },
  {
    id: 'movie-4', slug: 'spring', name: 'Spring', year: 2019, runtime: secs(7, 44), rating: R.PG, score: 7.6,
    genres: [G.animation, G.fantasy],
    overview: t(
      'A shepherd girl and her dog face ancient spirits to bring back the cycle of life, in a poetic tale about loss and renewal.',
      'Une jeune bergère et son chien affrontent d’anciens esprits pour relancer le cycle de la vie, dans un conte poétique sur la perte et le renouveau.',
    ),
    people: [person('Andy Goralczyk')],
  },
  {
    id: 'movie-5', slug: 'cosmos-laundromat', name: 'Cosmos Laundromat: First Cycle', year: 2015, runtime: secs(12, 10), rating: R.PG, score: 7.2,
    genres: [G.animation, G.comedy, G.fantasy],
    overview: t(
      'On a desolate island, a suicidal sheep named Franck meets his fate in a quirky salesman, who offers him the gift of a lifetime: many lifetimes, in fact.',
      'Sur une île désolée, Franck, un mouton suicidaire, croise la route d’un étrange vendeur qui lui offre le cadeau d’une vie. Et même de plusieurs.',
    ),
    people: [person('Mathieu Auvray'), person('Pierre Bokma', 'Actor', 'Franck'), person('Reinout Scholten van Aschat', 'Actor', 'Victor')],
  },
  {
    id: 'movie-6', slug: 'glass-half', name: 'Glass Half', year: 2015, runtime: secs(3, 13), rating: R.G, score: 6.8,
    genres: [G.animation, G.comedy],
    overview: t(
      'Two art critics in a gallery cannot agree on anything, starting with what they are looking at. A cartoon short about taste, rendered in the Blender viewport.',
      'Deux critiques d’art dans une galerie ne s’accordent sur rien, à commencer par ce qu’ils regardent. Un court métrage cartoon sur le goût, rendu dans le viewport de Blender.',
    ),
    people: [person('Beorn Leonard'), person('Ryan Millar', 'Actor', 'Max'), person('Trista Mrema', 'Actor', 'Min')],
  },
  {
    id: 'movie-7', slug: 'hero', name: 'Hero', year: 2018, runtime: secs(3, 58), rating: R.PG, score: 6.6,
    genres: [G.animation],
    // Plot-free on purpose: only what the Studio project page states (Grease Pencil showcase, director).
    overview: t(
      'The first Blender open movie made with Grease Pencil: a hand-drawn short that shows off 2D animation tools inside a full 3D pipeline, made for Blender 2.8.',
      'Le premier film libre Blender réalisé avec Grease Pencil : un court métrage dessiné à la main qui montre des outils d’animation 2D dans un pipeline 3D complet, réalisé pour Blender 2.8.',
    ),
    people: [person('Daniel Martinez Lara')],
  },
  {
    id: 'movie-8', slug: 'coffee-run', name: 'Coffee Run', year: 2020, runtime: secs(3, 4), rating: R.PG, score: 7.1,
    genres: [G.animation, G.drama],
    overview: t(
      'Fueled by caffeine, a young woman runs through the bittersweet memories of her past life, one coffee shop at a time.',
      'Portée par la caféine, une jeune femme traverse en courant les souvenirs doux-amers de sa vie, d’un café à l’autre.',
    ),
    people: [person('Hjalti Hjálmarsson')],
  },
  {
    id: 'movie-9', slug: 'sprite-fright', name: 'Sprite Fright', year: 2021, runtime: secs(10, 29), rating: R.PG13, score: 6.9,
    genres: [G.animation, G.horror, G.comedy],
    overview: t(
      'When a group of rowdy teenagers trek into an idyllic forest, they discover that the cute mushroom sprites living there are not as harmless as they look.',
      'Quand une bande d’adolescents turbulents s’aventure dans une forêt idyllique, ils découvrent que les adorables lutins champignons qui y vivent ne sont pas si inoffensifs.',
    ),
    people: [person('Matthew Luhn'), person('Hjalti Hjálmarsson', 'Director', t('Co-director', 'Coréalisation'))],
  },
  {
    id: 'movie-10', slug: 'charge', name: 'Charge', year: 2022, runtime: secs(3, 51), rating: R.PG13, score: 7.0,
    genres: [G.scifi, G.action],
    overview: t(
      'In a dystopian future, an old man breaks into a battery factory to steal the energy he needs to keep going, and the factory fights back.',
      'Dans un futur dystopique, un vieil homme s’introduit dans une usine de batteries pour voler l’énergie qui lui manque. Mais l’usine se défend.',
    ),
    people: [person('Hjalti Hjálmarsson')],
  },
  {
    id: 'movie-11', slug: 'wing-it', name: 'Wing It!', year: 2023, runtime: secs(3, 39), rating: R.G, score: 7.3,
    genres: [G.animation, G.comedy, G.family],
    overview: t(
      'A cat and a dog build a rocket out of junk in a barn, determined to reach the sky. What could possibly go wrong?',
      'Un chat et un chien construisent une fusée avec des bouts de ferraille dans une grange, bien décidés à atteindre le ciel. Que pourrait-il mal se passer ?',
    ),
    people: [person('Rik Schutte')],
  },
];
// Newest additions first in "Latest": the recent Blender Studio shorts lead the home screen.
const ADDED_ORDER = ['movie-9', 'movie-11', 'movie-10', 'movie-4', 'movie-2', 'movie-0', 'movie-5', 'movie-3', 'movie-8', 'movie-7', 'movie-1', 'movie-6'];

export const SERIES = {
  id: 'series-1', slug: 'caminandes', name: 'Caminandes', year: 2013, rating: R.G, score: 7.5,
  genres: [G.animation, G.comedy, G.family],
  overview: t(
    'In the vast plains of Patagonia, Koro the llama is convinced the grass is greener on the other side of the road, or the fence, or the frozen lake. A cartoon series inspired by the classic Chuck Jones shorts.',
    'Dans les grandes plaines de Patagonie, Koro le lama est persuadé que l’herbe est plus verte de l’autre côté de la route. Ou de la clôture. Ou du lac gelé. Une série cartoon inspirée des classiques de Chuck Jones.',
  ),
  people: [person('Pablo Vazquez')],
  episodes: [
    { id: 'ep-1-1', index: 1, name: 'Llama Drama', year: 2013, runtime: secs(1, 30), role: 'episode-1', overview: t('Koro wants to cross the road. The road has other plans.', 'Koro veut traverser la route. La route en a décidé autrement.') },
    { id: 'ep-1-2', index: 2, name: 'Gran Dillama', year: 2013, runtime: secs(2, 26), role: 'episode-2', overview: t('The grass on the other side of the electric fence looks delicious. Koro will find a way.', 'L’herbe derrière la clôture électrique a l’air délicieuse. Koro trouvera un moyen.') },
    { id: 'ep-1-3', index: 3, name: 'Llamigos', year: 2016, runtime: secs(2, 30), role: 'episode-3', overview: t('Winter in Patagonia: food is scarce, and Oti the pesky penguin wants the very last berry too.', 'L’hiver en Patagonie : la nourriture se fait rare, et Oti, le pingouin agaçant, convoite lui aussi la dernière baie.') },
  ],
};

// Dolby Vision / HDR on a few titles; everything else plays as SDR.
const SDR_1080 = { Codec: 'h264', Width: 1920, Height: 1080, VideoRange: 'SDR', VideoRangeType: undefined, ExtendedVideoType: 'None', DisplayTitle: '1080p H264 SDR' };
const SDR_4K = { Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'SDR', VideoRangeType: undefined, ExtendedVideoType: 'None', DisplayTitle: '4K HEVC SDR' };
const VIDEO = {
  // movie-0: two versions, see VERSIONS below (4K Dolby Vision + 1080p SDR). movie-9 keeps the stock 4K HDR10 stream.
  'movie-4': { VideoRange: 'HDR', VideoRangeType: undefined, ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81', ExtendedVideoSubTypeDescription: 'Profile 8.1 (HDR10 compatible)', ColorTransfer: 'smpte2084', DisplayTitle: '4K Dolby Vision' },
  'movie-5': { VideoRange: 'HDR', VideoRangeType: undefined, ExtendedVideoType: 'Hdr10Plus', DisplayTitle: '4K HEVC HDR10+' },
  'movie-10': { VideoRange: 'HDR', VideoRangeType: undefined, ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81', ExtendedVideoSubTypeDescription: 'Profile 8.1 (HDR10 compatible)', ColorTransfer: 'smpte2084', Height: 1608, DisplayTitle: '4K Dolby Vision' },
  'movie-1': SDR_1080, 'movie-2': SDR_4K, 'movie-3': SDR_4K, 'movie-6': SDR_4K, 'movie-7': SDR_1080, 'movie-8': SDR_1080, 'movie-11': SDR_4K,
};
const STREAMS = [
  { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, RealFrameRate: 24, VideoRange: 'HDR', VideoRangeType: 'HDR10', DisplayTitle: '4K HEVC HDR10' },
  { Index: 1, Type: 'Audio', Codec: 'eac3', Language: 'eng', Channels: 6, IsDefault: true, DisplayTitle: 'English EAC3 5.1' },
  { Index: 2, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, DisplayTitle: 'English AAC Stereo' },
  { Index: 3, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', DisplayTitle: 'English SRT' },
  // MOCK_PGS=1: a Blu-ray PGS track instead (the phone's PGS check, apps/mobile-web/scripts/pgs-check.mjs).
  process.env.MOCK_PGS
    ? { Index: 4, Type: 'Subtitle', Codec: 'pgssub', Language: 'eng', DisplayTitle: 'English PGS' }
    : { Index: 4, Type: 'Subtitle', Codec: 'subrip', Language: 'fre', DisplayTitle: 'Français SRT' },
];

const LISTS = {
  'playlist-1': { name: t('Sci-fi night', 'Soirée science-fiction'), members: ['movie-3', 'movie-10', 'movie-5', 'movie-1'] },
  'playlist-2': { name: t('Watch again', 'À revoir'), members: ['movie-2', 'movie-9', 'ep-1-3'] },
  'boxset-1': { name: t('Blender Open Movies: the classics', 'Films libres Blender : les classiques'), members: ['movie-1', 'movie-0', 'movie-2', 'movie-3'] },
  'boxset-2': { name: t('Blender Studio shorts', 'Courts métrages du Blender Studio'), members: ['movie-8', 'movie-9', 'movie-10', 'movie-11'] },
};
// Comics: the mock's generated albums, renamed (ids and pages unchanged).
export const COMIC_NAMES = {
  'comic-1': { name: t('The Cartographers, Vol. 1', 'Les Cartographes, tome 1'), series: t('The Cartographers', 'Les Cartographes') },
  'comic-2': { name: t('Sleepless Night', 'Nuit Blanche'), series: t('Sleepless Night', 'Nuit Blanche') },
  'comic-3': { name: t('RAR archive', 'Archive RAR') },
  'comic-4': { name: t('Vanishing Point', 'Ligne de fuite') },
};
const COMIC_GENRE = t('Comics', 'Bande dessinée');

// Live TV: the mock's channels ("<name>" or "<name> <n>"), programmes and recordings, renamed.
// 'Arte Test' becomes 'Culture Test' in both languages: Arte is a real broadcaster.
const CHANNEL_NAMES = {
  'Wika Info': t('Wika News', 'Wika Info'), 'Ciné Club': t('Movie Club', 'Ciné Club'), 'Docu Planète': t('Docu Planet', 'Docu Planète'),
  'Sport Direct': t('Sports Live', 'Sport Direct'), Junior: 'Junior', 'Musique Live': t('Live Music', 'Musique Live'), 'Séries+': t('Series+', 'Séries+'),
  'Arte Test': 'Culture Test', 'Météo 24': t('Weather 24', 'Météo 24'), Histoire: t('History', 'Histoire'), 'Cuisine TV': t('Cooking TV', 'Cuisine TV'), 'Nature HD': 'Nature HD',
};
const PROGRAM_NAMES = {
  'Le Journal': t('The News', 'Le Journal'), 'Grand Format': t('Long Form', 'Grand Format'), 'Les Explorateurs': t('The Explorers', 'Les Explorateurs'),
  'Film : Néon Fantôme': `${t('Movie: ', 'Film : ')}Sintel`, 'Match en direct': t('Live Match', 'Match en direct'), 'Dessins animés': t('Cartoons', 'Dessins animés'),
  'Concert acoustique': t('Acoustic Concert', 'Concert acoustique'), Enquêtes: t('Investigations', 'Enquêtes'), Magazine: 'Magazine', Documentaire: t('Documentary', 'Documentaire'),
};
const RECORDING_NAMES = { 'rec-1': t('The 1 pm News', 'Le Journal de 13 h'), 'rec-2': t('Long Form: The City', 'Grand Format : la ville'), 'rec-3': t('Saturday Concert', 'Concert du samedi') };

const LIBRARY_NAMES = { 'lib-movies': t('Movies', 'Films'), 'lib-shows': t('TV Shows', 'Séries'), 'lib-books': t('Comics', 'Bandes dessinées'), 'lib-livetv': t('Live TV', 'TV en direct'), 'lib-playlists': t('Playlists', 'Playlists'), 'lib-collections': t('Collections', 'Collections') };

// item id -> { Primary, Backdrop, Thumb } -> { file, tag, blurHash }
const images = new Map();

function setArt(item, map) {
  images.set(item.Id, map);
  item.ImageTags = { ...(map.Primary ? { Primary: map.Primary.tag } : {}), ...(map.Thumb ? { Thumb: map.Thumb.tag } : {}) };
  item.BackdropImageTags = map.Backdrop ? [map.Backdrop.tag] : [];
  item.ImageBlurHashes = {};
  for (const [type, a] of Object.entries(map)) if (a) (item.ImageBlurHashes[type] ??= {})[a.tag] = a.blurHash;
}

/**
 * Rewrites the mock catalogue. ctx: { items, ud, lists, streams, VIDEO_OVERRIDES, VERSIONS, TRAILERS, programs?, COMICS? }
 * (the mock's own objects, mutated in place).
 */
export function apply(ctx) {
  const { items, ud, lists, streams, VIDEO_OVERRIDES, VERSIONS, TRAILERS, programs, COMICS } = ctx;
  const now = Date.now();

  // 1. Drop the generated movie/show catalogue and the fictional people.
  for (const [id, it] of [...items]) {
    if (/^movie-x\d+$/.test(id) || it.Type === 'Person' || ((it.Type === 'Episode' || it.Type === 'Season') && it.SeriesId === 'series-1')) items.delete(id);
  }
  for (const [id, name] of Object.entries(LIBRARY_NAMES)) if (items.has(id)) items.get(id).Name = name;

  // 2. Films, on the mock's ids.
  const people = new Map();
  for (const m of MOVIES) {
    const a = art[m.slug];
    const order = ADDED_ORDER.indexOf(m.id);
    const item = {
      Id: m.id, Name: m.name, SortName: m.name.replace(/^(The|A) /, ''), Type: 'Movie', MediaType: 'Video', ParentId: 'lib-movies',
      ProductionYear: m.year, OfficialRating: m.rating, CommunityRating: m.score,
      RunTimeTicks: m.runtime, Genres: m.genres, Overview: m.overview, Taglines: m.tagline ? [m.tagline] : [],
      Studios: [{ Name: 'Blender Studio', Id: 'studio-blender' }],
      // Synthetic provider ids (as in the stock mock) so a second mock instance matches the same titles.
      ProviderIds: Number(m.id.slice(6)) < 4 ? { Imdb: `tt900000${m.id.slice(6)}`, Tmdb: String(9000 + Number(m.id.slice(6))) } : undefined,
      DateCreated: new Date(now - (order + 1) * day).toISOString(),
      People: m.people.map((p) => ({ Id: p.Id, Name: p.Name, Role: p.Role, Type: p.Type })),
      LocalTrailerCount: 0,
    };
    m.people.forEach((p) => people.set(p.Id, p));
    items.set(m.id, item);
    setArt(item, { Primary: a.poster, Backdrop: a.backdrop, Thumb: a.backdrop });
    if (VIDEO[m.id]) VIDEO_OVERRIDES[m.id] = VIDEO[m.id];
  }
  streams.splice(0, streams.length, ...STREAMS);
  // The mock's Latest rows follow the catalogue's insertion order: re-insert newest first.
  for (const id of ADDED_ORDER) {
    const it = items.get(id);
    items.delete(id);
    items.set(id, it);
  }

  // Big Buck Bunny: two versions (4K Dolby Vision, 1080p SDR), a local trailer and its YouTube upload
  // (the stock mock's YouTube links already point at Big Buck Bunny and Sintel).
  const base = VERSIONS['movie-0']?.()[0];
  if (base) {
    VERSIONS['movie-0'] = () => [
      { ...base, Name: 'Big Buck Bunny - 4K', Path: '/media/Big Buck Bunny (2008)/Big Buck Bunny - 4K.mkv', Size: 3_900_000_000, RunTimeTicks: secs(9, 56),
        MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, RealFrameRate: 60, VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81', ExtendedVideoSubTypeDescription: 'Profile 8.1 (HDR10 compatible)', ColorTransfer: 'smpte2084', DisplayTitle: '4K Dolby Vision' }, ...STREAMS.slice(1)] },
      { ...base, Id: 'movie-0-1080', Name: 'Big Buck Bunny - 1080p', Path: '/media/Big Buck Bunny (2008)/Big Buck Bunny - 1080p.mkv', Size: 900_000_000, RunTimeTicks: secs(9, 56),
        MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, RealFrameRate: 30, VideoRange: 'SDR', DisplayTitle: '1080p H264' }, { Index: 1, Type: 'Audio', Codec: 'ac3', Language: 'eng', Channels: 6, IsDefault: true, DisplayTitle: 'English AC3 5.1' }] },
    ];
  }
  Object.assign(items.get('movie-0'), { LocalTrailerCount: 1, RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', Name: 'Big Buck Bunny' }] });
  Object.assign(items.get('movie-2'), { RemoteTrailers: [{ Url: 'https://youtu.be/eRsGyueVLvQ', Name: 'Sintel' }] });
  for (const [id, film] of [['trailer-0', 'movie-0'], ['trailer-3', 'movie-3']]) {
    const f = items.get(film);
    const tr = { Id: id, Name: `${f.Name} · ${t('Trailer', 'Bande-annonce')}`, Type: 'Trailer', MediaType: 'Video', RunTimeTicks: secs(0, 52), ProductionYear: f.ProductionYear };
    items.set(id, tr);
    setArt(tr, { Primary: art[MOVIES.find((m) => m.id === film).slug].backdrop, Backdrop: art[MOVIES.find((m) => m.id === film).slug].backdrop });
  }
  TRAILERS['movie-0'] = ['trailer-0'];
  TRAILERS['movie-3'] = ['trailer-3'];
  items.get('movie-3').LocalTrailerCount = 1;

  // 3. Caminandes: series-1 / season-1 / three episodes.
  const S = SERIES;
  const ca = art[S.slug];
  const series = {
    Id: S.id, Name: S.name, Type: 'Series', ParentId: 'lib-shows', IsFolder: true, ProductionYear: S.year,
    EndDate: '2016-12-31T00:00:00.0000000Z', Status: 'Ended', OfficialRating: S.rating, CommunityRating: S.score, Genres: S.genres, Overview: S.overview,
    Studios: [{ Name: 'Blender Studio', Id: 'studio-blender' }], ProviderIds: { Tvdb: '424242' }, ChildCount: 1,
    DateCreated: new Date(now - 3.5 * day).toISOString(), People: S.people.map((p) => ({ Id: p.Id, Name: p.Name, Role: p.Role, Type: p.Type })),
  };
  S.people.forEach((p) => people.set(p.Id, p));
  items.set(S.id, series);
  setArt(series, { Primary: ca.poster, Backdrop: ca.backdrop, Thumb: ca.backdrop });
  const season = { Id: 'season-1', Name: t('Season 1', 'Saison 1'), Type: 'Season', IsFolder: true, SeriesId: S.id, SeriesName: S.name, IndexNumber: 1, ParentId: S.id, ProductionYear: S.year };
  items.set(season.Id, season);
  setArt(season, { Primary: ca.poster, Backdrop: ca.backdrop });
  for (const e of S.episodes) {
    const ep = {
      Id: e.id, Name: e.name, Type: 'Episode', MediaType: 'Video', SeriesId: S.id, SeriesName: S.name, SeasonId: season.Id, SeasonName: season.Name,
      ParentIndexNumber: 1, IndexNumber: e.index, ProductionYear: e.year, RunTimeTicks: e.runtime, Overview: e.overview,
      OfficialRating: S.rating, ParentBackdropItemId: S.id, ParentBackdropImageTags: [ca.backdrop.tag], SeriesPrimaryImageTag: ca.poster.tag,
      DateCreated: new Date(now - (4 - e.index) * day).toISOString(),
    };
    items.set(e.id, ep);
    setArt(ep, { Primary: ca[e.role], Thumb: ca[e.role] });
    // An episode has no backdrop of its own; the series backdrop is served for it.
    images.get(e.id).Backdrop = ca.backdrop;
    VIDEO_OVERRIDES[e.id] = SDR_1080;
  }

  // 4. Real crew (no portraits: the clients fall back to initials).
  for (const p of people.values()) items.set(p.Id, { Id: p.Id, Name: p.Name, Type: 'Person', ImageTags: {}, Overview: '' });

  // 5. Watch state: one film and one episode in progress, the first two episodes watched, a favourite.
  for (const id of [...items.keys()]) if (/^(movie|ep)-/.test(id)) Object.assign(ud(id), { PlaybackPositionTicks: 0, Played: false });
  ud('movie-2').PlaybackPositionTicks = secs(6, 12); // Sintel, 42 %
  ud('ep-1-3').PlaybackPositionTicks = secs(1, 5); // Llamigos, 43 %
  ud('ep-1-1').Played = true;
  ud('ep-1-2').Played = true;
  ud('movie-1').Played = true;
  ud('movie-0').IsFavorite = true;
  ud('movie-9').IsFavorite = true;

  // 6. Playlists and collections: new names and members; artwork from their first title.
  for (const [id, l] of Object.entries(LISTS)) {
    const it = items.get(id);
    if (!it || !lists?.has(id)) continue;
    it.Name = l.name;
    lists.set(id, l.members.map((itemId, i) => ({ entryId: `demo-${id}-${i}`, itemId })));
    it.ChildCount = l.members.length;
    const first = images.get(l.members[0]);
    setArt(it, { Primary: first.Primary, Backdrop: first.Backdrop });
  }

  // 7. Comics: names, genre and overview in the demo language (the CBZ pages are unchanged).
  for (const [id, c] of Object.entries(COMIC_NAMES)) {
    const it = items.get(id);
    if (!it) continue;
    Object.assign(it, {
      Name: c.name, Genres: [COMIC_GENRE], Path: `/books/${c.name}.${it.Container ?? 'cbz'}`,
      Overview: t(`${c.name}: test album generated by the demo server.`, `${c.name} : album de test généré par le serveur de démonstration.`),
    });
    const stock = COMICS?.[id];
    if (stock) {
      stock.name = c.name;
      if (c.series && stock.info) stock.info = stock.info.replace(/<Series>[^<]*<\/Series>/, `<Series>${c.series}</Series>`);
    }
  }

  // 8. Live TV: channel, programme and recording names (ids, guide times and series ids unchanged).
  const channelName = (name) => {
    if (CHANNEL_NAMES[name]) return CHANNEL_NAMES[name]; // 'Météo 24' is a name, not 'Météo' number 24
    const [, base, n] = /^(.*?)( \d+)?$/.exec(name);
    return CHANNEL_NAMES[base] ? `${CHANNEL_NAMES[base]}${n ?? ''}` : name;
  };
  for (const it of items.values()) if (it.Type === 'TvChannel') it.Name = channelName(it.Name);
  for (const p of programs ?? []) {
    p.Name = PROGRAM_NAMES[p.Name] ?? p.Name;
    p.ChannelName = items.get(p.ChannelId)?.Name ?? channelName(p.ChannelName);
    if (p.EpisodeTitle) p.EpisodeTitle = p.EpisodeTitle.replace(/^Épisode/, t('Episode', 'Épisode'));
    p.Overview = t(`${p.Name} on ${p.ChannelName}: fictional programme generated by the test server to fill the guide.`, `${p.Name} sur ${p.ChannelName} : programme fictif généré par le serveur de test pour remplir le guide.`);
  }
  for (const [id, name] of Object.entries(RECORDING_NAMES)) {
    const it = items.get(id);
    if (it) Object.assign(it, { Name: name, ChannelName: it.ChannelName && channelName(it.ChannelName), Overview: t('Test recording.', 'Enregistrement de test.') });
  }
}

// Admin pages (tools/mock-server/mock-admin/*.mjs read this through admin-demo.mjs): the activity log,
// the folder browser and the server logs use these instead of the stock fictional titles.
const shelf = (ids) => ids.map((id) => MOVIES.find((m) => m.id === id)).map((m) => `${m.name.replace(/:/g, ' -')} (${m.year})`); // no colon in a Windows folder name
export const ADMIN = {
  titles: ['Sintel', 'Spring', 'Sprite Fright', 'Charge', 'Wing It!', 'Caminandes: Llamigos'],
  tree: {
    'D:\\Media\\Films': shelf(['movie-0', 'movie-1', 'movie-2', 'movie-3', 'movie-4', 'movie-5', 'movie-6', 'movie-7']),
    '\\\\STORAGE\\media\\Films 4K': shelf(['movie-8', 'movie-9', 'movie-10', 'movie-11']),
    'D:\\Media\\Séries': ['Caminandes'],
    'D:\\Media\\Séries\\Caminandes': [t('Season 1', 'Saison 1')],
    '\\\\STORAGE\\media\\Séries': ['Caminandes'],
    '\\\\STORAGE\\media\\Séries\\Caminandes': [t('Season 1', 'Saison 1')],
    'D:\\Media\\BD': [...new Set(Object.values(COMIC_NAMES).map((c) => c.series ?? c.name))],
    'E:\\Musique': [t('Soundtracks', 'Bandes originales'), t('Live sessions', 'Sessions live')],
    'E:\\Livres audio': [t('Short stories', 'Nouvelles')],
  },
  log: {
    playing: 'Sintel',
    refreshing: 'Spring',
    probe: '/media/movies/Charge (2022)/Charge.mkv',
    ffmpegInput: '/media/movies/Sprite Fright (2021)/Sprite Fright.mkv',
  },
};

/** Serves demo artwork for /Items/{id}/Images/{type}[/{index}]. Returns false to let the mock draw its SVG. */
export function serveImage(res, id, type) {
  const a = images.get(id)?.[type === 'Banner' ? 'Thumb' : type];
  if (!a) return false;
  let data;
  try {
    data = fs.readFileSync(a.file);
  } catch {
    return false;
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400', ETag: `"${a.tag}"`, 'Access-Control-Allow-Origin': '*' });
  res.end(data);
  return true;
}

/** For tooling and tests: the artwork map (item id -> type -> { file, tag, blurHash }). */
export function imageFor(id, type) {
  return images.get(id)?.[type] ?? null;
}

export const attribution = ATTRIBUTION;
