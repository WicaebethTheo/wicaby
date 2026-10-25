// Library administration for the mock server: virtual folders (in memory), a fake
// server file system for the folder browser, library options, available fetchers,
// cultures/countries, and scans with progress.
// Global scans drive the "RefreshLibrary" task of 10-dashboard.mjs when it is there,
// so /ScheduledTasks shows them; per-library scans run on their own timer.
// Served by mock-jellyfin.mjs too (it forwards to the Emby handler); the options
// then carry Jellyfin's field names.
import { randomUUID } from 'node:crypto';
import { DEMO_ADMIN } from '../demo/admin-demo.mjs';

const JF = /mock-jellyfin/i.test(process.argv[1] ?? '');

function authed(req, q, tokens) {
  const token = req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(String(req.headers['x-emby-authorization'] ?? ''))?.[1];
  return token && tokens.has(token);
}

// Query values without caring about case (Jellyfin's forwarder capitalises names).
function qget(q, name) {
  const want = name.toLowerCase();
  for (const [k, v] of q) if (k.toLowerCase() === want) return v;
  return null;
}
const pick = (b, q, ...names) => {
  for (const n of names) {
    if (b && b[n] != null && b[n] !== '') return b[n];
    const v = qget(q, n);
    if (v != null && v !== '') return v;
  }
  return undefined;
};

// ---- Fake server file system ----

const TREE = {
  'C:\\': ['ProgramData', 'Users', 'Windows'],
  'C:\\Users': ['Public', 'Wika'],
  'C:\\Users\\Wika': ['Vidéos', 'Musique', 'Images'],
  'D:\\': ['Media', 'transcode-temp'],
  'D:\\Media': ['Films', 'Séries', 'BD'],
  'D:\\Media\\Films': ['Néon Fantôme (2024)', 'La Dernière Manche (2023)', 'Clutch (2025)', 'Uplink (2022)'],
  'D:\\Media\\Séries': ['Station Orbitale', 'Les Archives'],
  'D:\\Media\\Séries\\Station Orbitale': ['Saison 1', 'Saison 2'],
  'D:\\Media\\BD': ['Le Phare', 'Nuit Blanche'],
  'E:\\': ['Musique', 'Livres audio'],
  'E:\\Musique': ['Quatuor Nord', 'Les Ondes'],
  'E:\\Livres audio': ['Récits courts'],
  '\\\\STORAGE\\media': ['Films 4K', 'Séries'],
  '\\\\STORAGE\\media\\Films 4K': ['Radiant (2021)', 'Mjolnir (2020)'],
  '\\\\STORAGE\\media\\Séries': ['Station Orbitale', 'Le Signal'],
};
if (DEMO_ADMIN) Object.assign(TREE, DEMO_ADMIN.tree);
const DRIVES = ['C:\\', 'D:\\', 'E:\\'];
const SHARES = { '\\\\STORAGE': ['media'] };
const norm = (p) => String(p ?? '').replace(/\//g, '\\').replace(/(?<=.)\\+$/, (m, i, s) => (/^[A-Za-z]:\\$/.test(s) ? m : ''));

function children(path) {
  const key = Object.keys(TREE).find((k) => k.toLowerCase() === norm(path).toLowerCase() || (/^[A-Za-z]:$/.test(path) && k === `${path}\\`));
  if (!key) return null;
  return TREE[key].map((name) => ({ Name: name, Path: key.endsWith('\\') ? key + name : `${key}\\${name}`, Type: 'Directory' }));
}

// ---- Virtual folders ----

function baseOptions(type, paths, extra = {}) {
  const common = {
    EnablePhotos: true,
    EnableRealtimeMonitor: true,
    EnableChapterImageExtraction: false,
    ExtractChapterImagesDuringLibraryScan: false,
    PathInfos: paths.map((Path) => ({ Path })),
    SaveLocalMetadata: false,
    EnableAutomaticSeriesGrouping: true,
    EnableEmbeddedTitles: false,
    AutomaticRefreshIntervalDays: 0,
    PreferredMetadataLanguage: 'fr',
    MetadataCountryCode: 'FR',
    MetadataSavers: [],
    DisabledLocalMetadataReaders: [],
    LocalMetadataReaderOrder: [],
    DisabledSubtitleFetchers: [],
    SubtitleFetcherOrder: [],
    SkipSubtitlesIfEmbeddedSubtitlesPresent: false,
    SkipSubtitlesIfAudioTrackMatches: true,
    SubtitleDownloadLanguages: ['fre'],
    RequirePerfectSubtitleMatch: true,
    SaveSubtitlesWithMedia: true,
    TypeOptions: [],
  };
  const flavour = JF
    ? {
        Enabled: true,
        EnableLUFSScan: true,
        EnableTrickplayImageExtraction: false,
        ExtractTrickplayImagesDuringLibraryScan: false,
        SaveTrickplayWithMedia: false,
        EnableInternetProviders: true,
        EnableEmbeddedExtrasTitles: false,
        EnableEmbeddedEpisodeInfos: false,
        SeasonZeroDisplayName: 'Specials',
        AllowEmbeddedSubtitles: 'AllowAll',
        AutomaticallyAddToCollection: false,
      }
    : {
        EnableArchiveMediaFiles: false,
        EnableMarkerDetection: type === 'tvshows',
        EnableMarkerDetectionDuringLibraryScan: false,
        DownloadImagesInAdvance: false,
        PreferredImageLanguage: 'fr',
        ContentType: type,
        ThumbnailImagesIntervalSeconds: 10,
        IgnoreHiddenFiles: true,
        EnableAdultMetadata: false,
        ImportCollections: false,
        MinResumePct: 3,
        MaxResumePct: 90,
        MinResumeDurationSeconds: 120,
      };
  return { ...common, ...flavour, ...extra };
}

let folders;
function initFolders() {
  const mk = (Name, CollectionType, ItemId, Locations, extra) => ({
    Name,
    CollectionType,
    ItemId,
    Id: String(100 + (folders?.length ?? 0)),
    Guid: randomUUID().replace(/-/g, ''),
    Locations,
    LibraryOptions: baseOptions(CollectionType, Locations, extra),
  });
  folders = [];
  folders.push(mk('Films', 'movies', 'lib-movies', ['D:\\Media\\Films', '\\\\STORAGE\\media\\Films 4K'], { EnableChapterImageExtraction: true }));
  folders.push(mk('Séries', 'tvshows', 'lib-shows', ['\\\\STORAGE\\media\\Séries', 'D:\\Media\\Séries']));
  folders.push(mk('Bandes dessinées', 'books', 'lib-books', ['D:\\Media\\BD'], { EnableRealtimeMonitor: false }));
  folders.push(mk('Musique', 'music', 'lib-music', ['E:\\Musique'], { EnableRealtimeMonitor: false }));
}

const byName = (n) => folders.find((f) => f.Name.toLowerCase() === String(n ?? '').toLowerCase());
const byId = (id) => folders.find((f) => f.Id === id || f.ItemId === id);
const find = (b, q) => {
  const id = pick(b, q, 'Id', 'ItemId');
  return (id && byId(String(id))) || byName(pick(b, q, 'Name'));
};

// ---- Scans ----

// ItemId -> { start, ms } for per-library scans.
const libScans = new Map();
// Global scan when the dashboard task is not there to carry it.
let ownGlobal = null;

async function dashboard() {
  try {
    return await import('./10-dashboard.mjs');
  } catch {
    return null;
  }
}

// Calls 10-dashboard.mjs's router with a captured response (same auth headers).
async function dashCall(ctx, method, path) {
  const mod = await dashboard();
  if (!mod?.route) return undefined;
  let out;
  const fake = {
    ...ctx,
    req: { method, headers: ctx.req.headers, socket: ctx.req.socket, url: path, [Symbol.asyncIterator]: async function* () {} },
    p: path,
    parts: path.split('/').filter(Boolean),
    send: (_res, status, b) => {
      out = { status, body: b };
    },
  };
  const handled = await mod.route(fake);
  return handled ? out : undefined;
}

async function globalPct(ctx) {
  const r = await dashCall(ctx, 'GET', '/ScheduledTasks/t-scan');
  if (r?.status === 200 && r.body) return r.body.State === 'Running' ? Number(r.body.CurrentProgressPercentage ?? 0) : null;
  if (!ownGlobal) return null;
  const pct = ((Date.now() - ownGlobal.start) / ownGlobal.ms) * 100;
  if (pct >= 100) {
    ownGlobal = null;
    return null;
  }
  return pct;
}

async function view(ctx) {
  const g = await globalPct(ctx);
  const n = folders.length;
  return folders.map((f, i) => {
    let progress = null;
    const own = libScans.get(f.ItemId);
    if (own) {
      const pct = ((Date.now() - own.start) / own.ms) * 100;
      if (pct >= 100) libScans.delete(f.ItemId);
      else progress = pct;
    }
    // A global scan walks the libraries one after the other.
    if (progress == null && g != null && n) {
      const local = (g - (i * 100) / n) * n;
      if (local > 0 && local < 100) progress = local;
    }
    const out = { ...f, RefreshProgress: progress == null ? null : Math.round(progress * 10) / 10, RefreshStatus: progress == null ? 'Idle' : 'Active' };
    if (JF) delete out.Id;
    return out;
  });
}

function scanLibrary(f) {
  libScans.set(f.ItemId, { start: Date.now(), ms: 9000 + Math.random() * 5000 });
  console.log(`[mock-admin] scan library ${f.Name}`);
}

// ---- Reference data ----

const CULTURES = [
  ['French', 'fr', 'fre'],
  ['English', 'en', 'eng'],
  ['German', 'de', 'ger'],
  ['Spanish', 'es', 'spa'],
  ['Italian', 'it', 'ita'],
  ['Japanese', 'ja', 'jpn'],
  ['Portuguese', 'pt', 'por'],
  ['Dutch', 'nl', 'dut'],
  ['Korean', 'ko', 'kor'],
  ['Chinese', 'zh', 'chi'],
].map(([DisplayName, two, three]) => ({ Name: DisplayName, DisplayName, TwoLetterISOLanguageName: two, ThreeLetterISOLanguageName: three, ThreeLetterISOLanguageNames: [three] }));
const COUNTRIES = [
  ['France', 'FR'],
  ['Belgium', 'BE'],
  ['Switzerland', 'CH'],
  ['Canada', 'CA'],
  ['United States', 'US'],
  ['United Kingdom', 'GB'],
  ['Germany', 'DE'],
  ['Japan', 'JP'],
  ['Spain', 'ES'],
].map(([DisplayName, code]) => ({ Name: code, DisplayName, TwoLetterISORegionName: code, ThreeLetterISORegionName: code }));

const o = (Name, DefaultEnabled = true) => ({ Name, DefaultEnabled });
const META = JF ? [o('TheMovieDb'), o('The Open Movie Database'), o('TheTVDB', false)] : [o('TheMovieDb'), o('The Open Movie Database'), o('TheTVDB')];
const IMAGES = [o('TheMovieDb'), o('FanArt'), o('The Open Movie Database', false), o('Screen Grabber', false)];
const TYPES = {
  movies: ['Movie'],
  tvshows: ['Series', 'Season', 'Episode'],
  music: ['MusicArtist', 'MusicAlbum', 'Audio'],
  musicvideos: ['MusicVideo'],
  homevideos: ['Video'],
  books: ['Book'],
  audiobooks: ['AudioBook'],
};
function availableOptions(type) {
  const types = TYPES[type] ?? ['Movie', 'Series', 'Season', 'Episode'];
  return {
    MetadataSavers: [o('Nfo', false)],
    MetadataReaders: [o('Nfo')],
    SubtitleFetchers: type === 'music' || type === 'books' ? [] : [o('Open Subtitles'), o('Podnapisi', false), o('Addic7ed', false)],
    TypeOptions: types.map((Type) => ({
      Type,
      MetadataFetchers: Type === 'Audio' || Type === 'MusicAlbum' || Type === 'MusicArtist' ? [o('MusicBrainz'), o('TheAudioDB')] : Type === 'Book' || Type === 'AudioBook' ? [o('Google Books'), o('Comic Vine', false)] : META,
      ImageFetchers: Type === 'Season' ? [o('TheMovieDb'), o('TheTVDB', false)] : IMAGES,
      SupportedImageTypes: ['Primary', 'Backdrop', 'Logo', 'Thumb'],
      DefaultImageOptions: [],
    })),
  };
}

// ---- Router ----

const PREFIXES = ['/Library/VirtualFolders', '/Library/Refresh', '/Libraries/AvailableOptions', '/Environment/', '/Localization/Cultures', '/Localization/Countries'];

export async function route(ctx) {
  const { req, res, p, parts, q, send, body, tokens, items } = ctx;
  const m = req.method;
  const libRefresh = parts[0] === 'Items' && parts[2] === 'Refresh' && m === 'POST';
  if (!PREFIXES.some((x) => p === x || p.startsWith(x)) && !libRefresh) return false;
  if (!folders) initFolders();
  if (libRefresh && !byId(parts[1])) return false;
  if (!authed(req, q, tokens)) {
    send(res, 401, 'Unauthorized', 'text/plain');
    return true;
  }
  const ok = () => (send(res, 204), true);
  const notFound = (what = 'Library not found') => (send(res, 404, what, 'text/plain'), true);
  const syncItem = (f) => {
    if (!items) return;
    items.set(f.ItemId, { ...(items.get(f.ItemId) ?? {}), Id: f.ItemId, Name: f.Name, Type: 'CollectionFolder', CollectionType: f.CollectionType, IsFolder: true, ImageTags: { Primary: 't' } });
  };

  // -- Lists --
  if (p === '/Library/VirtualFolders' && m === 'GET') return send(res, 200, await view(ctx)), true;
  if (p === '/Library/VirtualFolders/Query' && m === 'GET') {
    if (JF) return notFound('Not found');
    const list = await view(ctx);
    return send(res, 200, { Items: list, TotalRecordCount: list.length }), true;
  }

  // -- Add --
  if (p === '/Library/VirtualFolders' && m === 'POST') {
    const b = await body(req);
    const name = String(pick(b, q, 'Name') ?? '').trim();
    if (!name) return send(res, 400, 'Name is required', 'text/plain'), true;
    if (byName(name)) return send(res, 400, 'A library with this name already exists', 'text/plain'), true;
    const type = pick(b, q, 'CollectionType') ?? null;
    const opts = b.LibraryOptions ?? {};
    const paths = [...new Set([...(Array.isArray(b.Paths) ? b.Paths : []), ...(opts.PathInfos ?? []).map((x) => x.Path)].filter(Boolean))];
    const f = {
      Name: name,
      CollectionType: type,
      ItemId: `lib-${randomUUID().slice(0, 8)}`,
      Id: String(100 + folders.length + Math.floor(Math.random() * 1000)),
      Guid: randomUUID().replace(/-/g, ''),
      Locations: paths,
      LibraryOptions: { ...baseOptions(type, paths), ...opts, PathInfos: paths.map((Path) => ({ Path })) },
    };
    folders.push(f);
    syncItem(f);
    console.log(`[mock-admin] add library ${name} (${type ?? 'mixed'}) ${paths.join(', ')}`);
    if (String(pick(b, q, 'RefreshLibrary')) === 'true') scanLibrary(f);
    return ok();
  }

  // -- Remove --
  if ((p === '/Library/VirtualFolders' && m === 'DELETE') || (p === '/Library/VirtualFolders/Delete' && m === 'POST')) {
    const b = m === 'POST' ? await body(req) : {};
    const f = find(b, q);
    if (!f) return notFound();
    folders = folders.filter((x) => x !== f);
    items?.delete(f.ItemId);
    console.log(`[mock-admin] remove library ${f.Name} (files untouched)`);
    return ok();
  }

  // -- Rename --
  if (p === '/Library/VirtualFolders/Name' && m === 'POST') {
    const b = await body(req);
    const f = find(b, q);
    const next = String(pick(b, q, 'NewName') ?? '').trim();
    if (!f) return notFound();
    if (!next) return send(res, 400, 'NewName is required', 'text/plain'), true;
    if (byName(next) && byName(next) !== f) return send(res, 400, 'A library with this name already exists', 'text/plain'), true;
    console.log(`[mock-admin] rename library ${f.Name} -> ${next}`);
    f.Name = next;
    syncItem(f);
    return ok();
  }

  // -- Paths --
  if (p === '/Library/VirtualFolders/Paths' && m === 'POST') {
    const b = await body(req);
    const f = find(b, q);
    const path = b.PathInfo?.Path ?? pick(b, q, 'Path');
    if (!f) return notFound();
    if (!path) return send(res, 400, 'Path is required', 'text/plain'), true;
    if (!f.Locations.includes(path)) f.Locations.push(path);
    f.LibraryOptions.PathInfos = f.Locations.map((Path) => ({ Path }));
    console.log(`[mock-admin] ${f.Name}: add path ${path}`);
    return ok();
  }
  if ((p === '/Library/VirtualFolders/Paths' && m === 'DELETE') || (p === '/Library/VirtualFolders/Paths/Delete' && m === 'POST')) {
    const b = m === 'POST' ? await body(req) : {};
    const f = find(b, q);
    const path = pick(b, q, 'Path');
    if (!f) return notFound();
    f.Locations = f.Locations.filter((x) => x.toLowerCase() !== String(path).toLowerCase());
    f.LibraryOptions.PathInfos = f.Locations.map((Path) => ({ Path }));
    console.log(`[mock-admin] ${f.Name}: remove path ${path}`);
    return ok();
  }

  // -- Options --
  if (p === '/Library/VirtualFolders/LibraryOptions' && m === 'POST') {
    const b = await body(req);
    const f = find(b, q);
    if (!f) return notFound();
    f.LibraryOptions = { ...f.LibraryOptions, ...(b.LibraryOptions ?? {}), PathInfos: f.Locations.map((Path) => ({ Path })) };
    console.log(`[mock-admin] ${f.Name}: options saved (realtime ${f.LibraryOptions.EnableRealtimeMonitor}, lang ${f.LibraryOptions.PreferredMetadataLanguage || 'server'})`);
    return ok();
  }
  if (p === '/Libraries/AvailableOptions' && m === 'GET') return send(res, 200, availableOptions(qget(q, 'LibraryContentType') ?? 'mixed')), true;

  // -- Scans --
  if (p === '/Library/Refresh' && m === 'POST') {
    const r = await dashCall(ctx, 'POST', '/ScheduledTasks/Running/t-scan');
    if (!r) ownGlobal = { start: Date.now(), ms: 30_000 };
    console.log('[mock-admin] scan all libraries');
    return ok();
  }
  if (libRefresh) {
    scanLibrary(byId(parts[1]));
    return ok();
  }

  // -- Reference data --
  if (p === '/Localization/Cultures') return send(res, 200, CULTURES), true;
  if (p === '/Localization/Countries') return send(res, 200, COUNTRIES), true;

  // -- Server file system --
  if (p === '/Environment/Drives') return send(res, 200, DRIVES.map((d) => ({ Name: d, Path: d, Type: 'Directory' }))), true;
  if (p === '/Environment/DefaultDirectoryBrowser') return send(res, 200, { Path: 'D:\\Media' }), true;
  if (p === '/Environment/NetworkDevices') {
    if (JF) return notFound('Not found');
    return send(res, 200, Object.keys(SHARES).map((d) => ({ Name: d.slice(2), Path: d, Type: 'NetworkComputer' }))), true;
  }
  if (p === '/Environment/NetworkShares') {
    const dev = norm(qget(q, 'Path'));
    const list = SHARES[Object.keys(SHARES).find((k) => k.toLowerCase() === dev.toLowerCase())];
    if (!list) return notFound('Device not found');
    return send(res, 200, list.map((s) => ({ Name: s, Path: `${dev}\\${s}`, Type: 'NetworkShare' }))), true;
  }
  if (p === '/Environment/DirectoryContents') {
    const path = qget(q, 'Path') ?? '';
    const list = children(path);
    // Unknown folders under a known tree exist but are empty; anything else is missing.
    if (!list) return /^([A-Za-z]:\\|\\\\STORAGE\\)/i.test(norm(path)) ? (send(res, 200, []), true) : notFound('Directory not found');
    return send(res, 200, list), true;
  }
  if (p === '/Environment/ParentPath') {
    const path = norm(qget(q, 'Path'));
    const i = path.replace(/\\$/, '').lastIndexOf('\\');
    return send(res, 200, i > 2 ? path.slice(0, i) : path.slice(0, 3), 'text/plain'), true;
  }
  return false;
}
