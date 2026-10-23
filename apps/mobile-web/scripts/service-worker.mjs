// Vite plugin: builds worker/sw.ts into sw.js next to the app, with the list of files to precache (every emitted
// chunk, style, font and public file) and a version derived from their names. Hashed names change with their
// content, so the version changes exactly when the app does: the browser then installs the new worker, and the app
// offers to reload (src/lib/updates.svelte.ts). Not used by `npm run dev` (no worker there).
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENTRY = path.resolve(import.meta.dirname, '..', 'worker', 'sw.ts');
// Font subsets for other scripts (Cyrillic, Vietnamese, symbols) load only when a page shows such text, through
// their unicode-range: not worth precaching for every install.
const ON_DEMAND = /geist(-mono)?-(cyrillic|cyrillic-ext|vietnamese|greek|symbols\d*)-/;

function publicFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? publicFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

export default function serviceWorker() {
  let config;
  let files = [];
  return {
    name: 'wicaby-service-worker',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    generateBundle(_, bundle) {
      files = Object.keys(bundle);
    },
    async closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir);
      // Source maps are for debugging only: the app never fetches them.
      const precache = [...new Set([...files, ...publicFiles(config.publicDir)])].filter((f) => !f.endsWith('.map') && !ON_DEMAND.test(f)).sort();
      const version = crypto.createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      await build({
        entryPoints: [ENTRY],
        outfile: path.join(outDir, 'sw.js'),
        bundle: true,
        format: 'iife',
        target: config.build.target,
        minify: true,
        legalComments: 'none',
        define: { __PRECACHE__: JSON.stringify(precache), __SW_VERSION__: JSON.stringify(version) },
        logLevel: 'warning',
      });
    },
  };
}
