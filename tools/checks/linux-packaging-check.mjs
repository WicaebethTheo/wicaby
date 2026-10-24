// Self-check for the Linux packages (docs/desktop.md, "Linux packages"):
// - the tar.gz launcher (apps/desktop/build/wicaby.sh): shipped next to the binary, executable in the release, and on
//   Linux it adds --no-sandbox only when neither user namespaces nor a setuid chrome-sandbox are usable;
// - the AppImage uses the static runtime (no libfuse2);
// - mpv-controller.ts drops the AppImage's $APPDIR folders from mpv's LD_LIBRARY_PATH and PATH.
// Usage: node tools/checks/linux-packaging-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const ok = (msg) => console.log(`ok  ${msg}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-linux-pkg-'));

try {
  // ---- Packaging (static) ----
  const eb = read('apps/desktop/electron-builder.yml');
  const linux = /^linux:\n((?:[ #].*\n|\n)*)/m.exec(eb)?.[1] ?? '';
  assert.match(linux, /^ {2}extraFiles:\n {4}- from: build\/wicaby\.sh\n {6}to: wicaby\.sh\n/m, 'linux.extraFiles puts the launcher next to the binary');
  assert.match(eb, /^toolsets:\n {2}appimage: '1\.0\.3'\n/m, 'AppImage built with the static runtime (no libfuse2)');
  assert.match(read('.github/workflows/release.yml'), /chmod \+x build\/wicaby\.sh\n\s+npx electron-builder --linux /, 'release.yml makes the launcher executable before packaging');
  const sh = read('apps/desktop/build/wicaby.sh');
  assert.ok(sh.startsWith('#!/bin/sh\n') && !sh.includes('\r'), 'launcher: POSIX sh shebang, LF line ends');
  ok('launcher in linux.extraFiles and chmod +x in release.yml; AppImage toolset 1.0.3');

  // ---- The launcher (needs a POSIX sh: Linux, macOS) ----
  if (process.platform === 'win32') {
    console.log('skip  launcher run: needs a POSIX sh');
  } else {
    // A fake wicaby that prints its arguments, and an unshare that succeeds or fails on demand.
    const app = path.join(tmp, 'app');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(app);
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(repo, 'apps/desktop/build/wicaby.sh'), path.join(app, 'wicaby.sh'));
    fs.writeFileSync(path.join(app, 'wicaby'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'unshare'), '#!/bin/sh\nexit "$UNSHARE_STATUS"\n', { mode: 0o755 });
    // A symlink, as from ~/.local/bin: the binary is found next to the script it points to.
    fs.symlinkSync(path.join(app, 'wicaby.sh'), path.join(tmp, 'link.sh'));
    const run = (status) =>
      execFileSync('sh', [path.join(tmp, 'link.sh'), '--wicaby-nav=/home', 'a b'], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, UNSHARE_STATUS: String(status) },
      }).trim();
    assert.equal(run(0), '--wicaby-nav=/home a b', 'user namespaces work: the sandbox stays on');
    assert.equal(run(1), '--no-sandbox --wicaby-nav=/home a b', 'user namespaces blocked: --no-sandbox');
    fs.writeFileSync(path.join(app, 'chrome-sandbox'), '');
    fs.chmodSync(path.join(app, 'chrome-sandbox'), 0o4755);
    if (fs.statSync(path.join(app, 'chrome-sandbox')).mode & 0o4000) assert.equal(run(1), '--wicaby-nav=/home a b', 'setuid chrome-sandbox: the sandbox stays on');
    ok('launcher: --no-sandbox only when user namespaces and a setuid chrome-sandbox are both unavailable');
  }

  // ---- mpv's environment from an AppImage ----
  const outfile = path.join(tmp, 'mpv-controller.mjs');
  await build({
    entryPoints: [path.join(repo, 'apps/desktop/src/main/playback/mpv-controller.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    plugins: [{ name: 'electron-stub', setup: (b) => {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = { getPath: () => "", getLocale: () => "en", on() {} };' }));
    } }],
  });
  const { withoutAppDirPaths } = await import(pathToFileURL(outfile).href);
  const plain = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/lib' };
  assert.equal(withoutAppDirPaths(plain), plain, 'no APPDIR: the environment is unchanged');
  assert.deepEqual(
    withoutAppDirPaths({ APPDIR: '/tmp/.mount_WicabyX/', PATH: '/tmp/.mount_WicabyX/usr/bin:/tmp/.mount_WicabyXY/bin:/usr/bin', LD_LIBRARY_PATH: '/tmp/.mount_WicabyX/usr/lib:/tmp/.mount_WicabyX', HOME: '/home/me' }),
    { APPDIR: '/tmp/.mount_WicabyX/', PATH: '/tmp/.mount_WicabyXY/bin:/usr/bin', HOME: '/home/me' },
    'APPDIR folders dropped (prefix match on whole folders), an emptied LD_LIBRARY_PATH unset',
  );
  ok('withoutAppDirPaths: $APPDIR folders out of mpv\'s PATH and LD_LIBRARY_PATH');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
