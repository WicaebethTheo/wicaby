import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import androidStrings from './scripts/android-strings.mjs';
import csp from './scripts/csp.mjs';
import serviceWorker from './scripts/service-worker.mjs';
// The repository's version (the release tag), shared by every app.
import pkg from '../../package.json' with { type: 'json' };
import { execSync } from 'node:child_process';

// The commit built, shown in Settings > About: which update a phone runs.
const build = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
})();

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TV_SRC = here('../tv-web/src');

// The oldest engine: Safari 17 (iOS 17), the first with ManagedMediaSource, the switch haptic (17.4) and every web
// app API the shell uses (Push, Badging, Screen Wake Lock, View Transitions arrive in 18 and are optional).
export const ENGINE = 'safari17';

// The TV web app's platform-neutral logic (API client, sessions, playback, music, Live TV, photos…) is reused as is.
// Its few seams with the TV shell (the focus-driven screen stack, the dialog layer, the dp scale and the TV platform)
// resolve to this app's own modules, which keep the same exports: the TV code needs no fork and no change.
const SEAMS: Record<string, string> = {
  'lib/nav.svelte': here('src/lib/nav.svelte.ts'),
  'lib/overlay.svelte': here('src/lib/overlay.svelte.ts'),
  'lib/screen': here('src/lib/screen.ts'),
  // Safari's own rules (HEVC only in MP4/fMP4, no MKV, AC3/EAC3 in HLS): an iPhone profile, not the TV's.
  'lib/device-profile': here('src/lib/device-profile.ts'),
  'lib/identity': here('src/lib/identity.ts'),
  platform: here('src/platform/index.ts'),
  'platform/index': here('src/platform/index.ts'),
  'platform/caps': here('src/platform/caps.ts'),
};

const tvSeams: Plugin = {
  name: 'wicaby-tv-seams',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null;
    const from = path.resolve(path.dirname(importer.split('?')[0]), source);
    if (!from.startsWith(TV_SRC)) return null;
    const key = path.relative(TV_SRC, from).split(path.sep).join('/').replace(/\.ts$/, '');
    return SEAMS[key] ?? null;
  },
};

// The desktop's server administration (renderer/admin: dashboard, users, libraries, tasks, transcoding, plugins,
// logs, an item's metadata, artwork, identification…) is reused as is too. Its seams with the Electron renderer (the
// IPC bridge, the stores, the router, the modal sheet) resolve to src/desktop, which keeps the same exports over this
// app's sessions; only the catalogs the admin reads load, and its media URLs point at the server instead of main.
const DESKTOP_SRC = here('../desktop/src/renderer');
const DESKTOP_SEAMS: Record<string, string> = {
  'lib/bridge': here('src/desktop/bridge.ts'),
  'lib/stores.svelte': here('src/desktop/stores.svelte.ts'),
  'lib/api': here('src/desktop/api.ts'),
  'lib/router.svelte': here('src/desktop/router.svelte.ts'),
  'components/Sheet.svelte': here('src/desktop/Sheet.svelte'),
};
const ADMIN_CATALOGS = 'admin,adminLibraries,adminMetadata,adminServer,adminUsers,common,errors';
// Exact rewrites: a desktop change that moves one of these fails the build instead of shipping a dead URL.
const DESKTOP_REWRITES: Record<string, [string, string][]> = {
  'lib/i18n.svelte.ts': [["'../locales/*/*.json'", `'../locales/*/{${ADMIN_CATALOGS}}.json'`]],
  'admin/item/metadata.ts': [
    ['`${MEDIA_SCHEME}://api${server}/Items/', '`${mediaBase(item.ServerId)}/Items/'],
    ['`${MEDIA_SCHEME}://remote-image/?u=${encodeURIComponent(url)}`', 'url'],
    ["import { comicCoverUrl } from '../../lib/images';", "import { comicCoverUrl, mediaBase } from '../../lib/images';"],
  ],
};

const desktopSeams: Plugin = {
  name: 'wicaby-desktop-seams',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null;
    const from = path.resolve(path.dirname(importer.split('?')[0]), source);
    if (!from.startsWith(DESKTOP_SRC)) return null;
    const key = path.relative(DESKTOP_SRC, from).split(path.sep).join('/').replace(/\.ts$/, '');
    // Forward slashes: the Svelte plugin finds a component's compiled CSS by the id the component was loaded under.
    return DESKTOP_SEAMS[key] ? normalizePath(DESKTOP_SEAMS[key]) : null;
  },
  transform(code, id) {
    const file = path.resolve(id.split('?')[0]);
    if (!file.startsWith(DESKTOP_SRC)) return null;
    const rewrites = DESKTOP_REWRITES[path.relative(DESKTOP_SRC, file).split(path.sep).join('/')];
    if (!rewrites) return null;
    for (const [from, to] of rewrites) {
      if (!code.includes(from)) throw new Error(`${file}: "${from}" not found (desktop seam out of date)`);
      code = code.split(from).join(to);
    }
    return { code, map: null };
  },
};

export default defineConfig({
  root: 'src',
  // Relative: the app is served from a sub-path (GitHub Pages /wicaby/) as well as from a root.
  base: './',
  publicDir: '../public',
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILD__: JSON.stringify(build) },
  plugins: [tvSeams, desktopSeams, svelte(), androidStrings(), csp(), serviceWorker()],
  resolve: {
    alias: {
      $shared: here('../desktop/src/shared'),
      $desktop: here('../desktop/src/renderer/lib'),
      $android: here('../android'),
      $tv: here('../tv-web/src/lib'),
      $tvplatform: here('../tv-web/src/platform'),
      // The desktop's scrobble client signs Last.fm calls with node:crypto's MD5: the TV app's pure one.
      'node:crypto': here('../tv-web/src/platform/node-crypto.ts'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ENGINE,
    cssTarget: ENGINE,
    assetsInlineLimit: 0,
    // Screens past the first load on demand; the service worker precaches every chunk, so a later visit opens offline.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5399,
    strictPort: true,
    fs: { allow: [here('../..')] },
  },
});
