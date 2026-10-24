// Self-check for the Linux libmpv render addon (apps/desktop/native/mpv-render, docs/desktop.md):
// - packaging, on every platform: build:native runs first in `npm run build`, the binding.gyp is not at a
//   package root (npm would add a hidden `node-gyp rebuild` install script), asarUnpack, the deb depends;
// - the built out/native/wicaby_mpv.node, on Linux: it loads in Node (Node-API, the same binary as in
//   Electron), probe() answers (with its render-node check), libmpv is dlopened, not a NEEDED entry (the app must
//   start without it), and libstdc++/libgcc_s are linked statically (no GLIBCXX_* floor).
// Not covered (#63): this runs under plain Node, where there is no Electron libffmpeg.so to rebind, and CI runners
// have no libmpv, so ffmpeg_rebind.cc and mpv_api.cc past dlopen are only exercised by the manual
// native/mpv-render/test scripts (smoke.cjs needs libmpv and a /dev/dri render node) and real runs in Electron.
// Skips the binary part when not on Linux or not built; --require (CI, after `npm run build`) fails instead.
// Usage: node tools/checks/native-addon-check.mjs [--require]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const desktop = path.join(repo, 'apps', 'desktop');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const ok = (msg) => console.log(`ok  ${msg}`);

// ---- Packaging (static) ----
const pkg = JSON.parse(read('apps/desktop/package.json'));
assert.match(pkg.scripts.build, /^npm run build:native && /, 'build runs build:native first');
assert.equal(pkg.scripts['build:native'], 'node scripts/build-native.mjs');
assert.equal(pkg.devDependencies['node-addon-api'], '8.9.2');
assert.equal(pkg.devDependencies['node-gyp'], '12.4.0');
for (const dir of ['', 'apps/desktop', 'apps/tv-web']) assert.ok(!fs.existsSync(path.join(repo, dir, 'binding.gyp')), `no binding.gyp at the ${dir || 'repo'} package root`);
const native = read('apps/desktop/scripts/build-native.mjs');
assert.match(native, /process\.platform !== 'linux'[\s\S]*?process\.exit\(0\)/, 'build-native exits 0 off Linux');
assert.match(read('apps/desktop/scripts/build-main.mjs'), /process\.platform === 'linux'[\s\S]*?out\/native\/wicaby_mpv\.node/, 'build-main copies the addon on Linux only');
const eb = read('apps/desktop/electron-builder.yml');
assert.match(eb, /^asarUnpack:\n {2}- out\/native\/\*\*\/\*\.node$/m);
for (const dep of ['mpv \\(>= 0\\.37\\)', 'libmpv2 \\(>= 0\\.37\\)', 'libgbm1', 'libegl1', 'libgles2']) assert.match(eb, new RegExp(`^ {4}- ${dep}$`, 'm'), `deb depends on ${dep}`);
// CI and the release build the shipped addon in Ubuntu 22.04, for the glibc floor checked below.
for (const wf of ['ci.yml', 'release.yml']) {
  const y = read(`.github/workflows/${wf}`);
  assert.match(y, /WICABY_SKIP_NATIVE: '1'\n\s+run: npm run build\b/, `${wf}: the runner's npm run build skips the addon`);
  assert.match(y, /ubuntu:22\.04 bash -euo pipefail <<'EOF'\n[\s\S]*?node apps\/desktop\/scripts\/build-native\.mjs\n[\s\S]*?apps\/desktop\/out\/native\/\n/, `${wf}: the addon is built in ubuntu:22.04`);
}
ok('package.json build:native, no binding.gyp at a package root, asarUnpack, deb depends, addon built in Ubuntu 22.04');

// ---- The built addon (Linux) ----
const require_ = process.argv.includes('--require');
const addon = path.join(desktop, 'out', 'native', 'wicaby_mpv.node');
if (process.platform !== 'linux') {
  console.log(`skip  out/native/wicaby_mpv.node: Linux only (${process.platform})`);
  process.exit(0);
}
if (!fs.existsSync(addon)) {
  if (require_) assert.fail(`${path.relative(repo, addon)} is missing: run npm run build on Linux (see build-native.mjs)`);
  console.log('skip  out/native/wicaby_mpv.node not built (npm run build)');
  process.exit(0);
}

const mod = createRequire(import.meta.url)(addon);
assert.equal(typeof mod.probe, 'function', 'exports probe()');
assert.equal(typeof mod.create, 'function', 'exports create()');
const probe = mod.probe();
assert.equal(typeof probe?.ok, 'boolean', 'probe() returns { ok }');
// A runner without libmpv answers ok: false with a reason; the app then keeps mpv's own window.
if (probe.ok) assert.ok(Number.isInteger(probe.apiVersion) && probe.apiVersion >= ((2 << 16) | 1), `libmpv client API ${probe.apiVersion} >= 2.1 (render API)`);
else assert.ok(typeof probe.error === 'string' && probe.error.length > 0, 'probe() gives a reason when libmpv is unusable');
// The render check (index.ts picks texture only when it passes): which node, and why it failed.
if (probe.ok) {
  assert.equal(typeof probe.render?.ok, 'boolean', 'probe() returns render: { ok, node }');
  assert.equal(typeof probe.render.node, 'string');
  if (!probe.render.ok) assert.ok(typeof probe.render.error === 'string' && probe.render.error.length > 0, 'a failed render check gives a reason');
}
const renderText = probe.render ? `, render ${probe.render.ok ? `ok on ${probe.render.node}` : `unavailable (${probe.render.error})`}` : '';
ok(`addon loads in Node ${process.versions.node}; probe(): ${probe.ok ? `libmpv API ${probe.apiVersion >> 16}.${probe.apiVersion & 0xffff}${renderText}` : `unavailable (${probe.error})`}`);

let dyn;
try {
  dyn = execFileSync('readelf', ['-d', addon], { encoding: 'utf8' });
} catch (e) {
  if (require_) throw e;
  console.log(`skip  readelf not available (${e.code ?? e.message})`);
  process.exit(0);
}
const needed = [...dyn.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
assert.ok(needed.length > 0, 'readelf lists NEEDED entries');
assert.ok(!needed.some((n) => /^libmpv\b/.test(n)), `libmpv is dlopened, not linked (NEEDED: ${needed.join(', ')})`);
// binding.gyp links the GCC runtime statically, so the addon needs no GLIBCXX_* from the user's libstdc++ (#12). A
// failure here on a local build made before that flag: npm run build:native -w apps/desktop.
assert.ok(!needed.some((n) => /^lib(stdc\+\+|gcc_s)\.so/.test(n)), `libstdc++ and libgcc_s are linked statically (NEEDED: ${needed.join(', ')})`);
ok(`NEEDED: ${needed.join(', ')}`);

// Symbol versions: no GLIBCXX at all; on CI (--require, built in an ubuntu:22.04 container) nothing newer than
// glibc 2.35, so the addon loads on Ubuntu 22.04 and Debian 12. Built on glibc 2.38 or later, strtol and friends
// bind to __isoc23_* @GLIBC_2.38, so a local build on a newer distro may need more.
let syms = '';
try {
  syms = execFileSync('objdump', ['-T', addon], { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (e) {
  if (require_) throw e;
  console.log(`skip  objdump not available (${e.code ?? e.message})`);
}
if (syms) {
  const versions = (prefix) => [...new Set([...syms.matchAll(new RegExp(`\\b${prefix}_(\\d+(?:\\.\\d+)*)\\b`, 'g'))].map((m) => m[1]))];
  const cmp = (a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const cxx = versions('GLIBCXX');
  assert.deepEqual(cxx, [], `no GLIBCXX_* symbol versions (found ${cxx.join(', ')})`);
  const glibc = versions('GLIBC').sort(cmp).at(-1) ?? 'none';
  if (require_) assert.ok(glibc === 'none' || cmp(glibc, '2.35') <= 0, `highest GLIBC_ version ${glibc} <= 2.35 (Ubuntu 22.04)`);
  ok(`no GLIBCXX symbol versions; highest GLIBC_${glibc}`);
}
