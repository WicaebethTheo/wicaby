// Builds the Linux libmpv render addon (native/mpv-render) with node-gyp. `npm run build` runs it first;
// scripts/build-main.mjs then copies build/Release/wicaby_mpv.node to out/native/.
// Exits 0 without building on Windows and macOS (mpv stays an external process there), when the sources are
// absent, or with WICABY_SKIP_NATIVE=1 (the app then falls back to mpv's own window on Wayland).
// A failed build fails `npm run build`: a release must not lose in-window Wayland playback silently.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'native', 'mpv-render');

if (process.platform !== 'linux') {
  console.log(`build-native: skipped on ${process.platform} (Linux only)`);
  process.exit(0);
}
if (process.env.WICABY_SKIP_NATIVE === '1') {
  console.log('build-native: skipped (WICABY_SKIP_NATIVE=1)');
  process.exit(0);
}
if (!fs.existsSync(path.join(dir, 'binding.gyp'))) {
  console.log('build-native: skipped, no native/mpv-render/binding.gyp');
  process.exit(0);
}

const nodeGyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js');
const args = [nodeGyp, 'rebuild', '-C', dir, '--jobs=max'];
// mise, nvm and actions/setup-node ship the headers next to the binary; using them skips node-gyp's download
// from nodejs.org. Node-API is ABI-stable, so the same binary loads in Electron (no electron-rebuild).
const prefix = path.dirname(path.dirname(process.execPath));
if (fs.existsSync(path.join(prefix, 'include', 'node', 'node_api.h'))) args.push(`--nodedir=${prefix}`);

const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(
    'build-native: node-gyp failed. It needs a C++17 compiler, make, python3, pkg-config and the EGL, GLESv2 and ' +
      'GBM development files (Debian/Ubuntu: pkg-config libgbm-dev libegl-dev libgles-dev; Arch: base-devel pkgconf mesa libglvnd). ' +
      'Set WICABY_SKIP_NATIVE=1 to build without the addon.',
  );
  process.exit(r.status ?? 1);
}
