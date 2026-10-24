// Release supply-chain self-check: the licence folder, pinned actions and mpv, the vendor/mpv
// filter, and one version across the npm packages and the CHANGELOG.
// Usage: node tools/checks/release-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);

// 1. tools/release/licenses.mjs stages every licence file, and npm-licenses.txt covers the
//    renderer libraries named in THIRD_PARTY_NOTICES.md.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-licenses-'));
try {
  execFileSync(process.execPath, [path.join(root, 'tools', 'release', 'licenses.mjs'), tmp], { stdio: 'pipe' });
  const out = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
  assert.match(out('LICENSE.txt'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(out('GPL-2.0.txt'), /GNU GENERAL PUBLIC LICENSE\s+Version 2/);
  assert.match(out('LGPL-2.1.txt'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/);
  assert.equal(out('THIRD_PARTY_NOTICES.md'), read('THIRD_PARTY_NOTICES.md'));
  const npm = out('npm-licenses.txt');
  for (const pkg of ['svelte', 'clsx', 'esm-env', 'hls.js', '@lucide/svelte', '@fontsource-variable/geist', '@fontsource-variable/geist-mono']) {
    const m = new RegExp(`^${pkg.replace(/[.]/g, '\\.')} \\S+ \\(.*\\)\\n=+\\n\\n(.+)`, 'm').exec(npm);
    assert.ok(m && m[1].trim().length > 0, `npm-licenses.txt has no licence text for ${pkg}`);
  }
  ok('licenses.mjs stages LICENSE.txt, the GPL/LGPL texts, the notices and the npm licences');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2. Every action is pinned to a full commit SHA, with its version in a comment.
for (const f of fs.readdirSync(path.join(root, '.github', 'workflows'))) {
  for (const [line] of read(`.github/workflows/${f}`).matchAll(/^\s*-?\s*uses:.*$/gm)) {
    assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${f}: ${line.trim()}`);
  }
}
ok('workflow actions are pinned to commit SHAs');

// 3. mpv is pinned (tag, commit, SHA-256 per variant), and the notices name the same build.
const ps1 = read('apps/desktop/scripts/fetch-mpv.ps1');
const tag = /^\$MpvTag = '(\d{8})'/m.exec(ps1)?.[1];
const commit = /^\$MpvCommit = '([0-9a-f]{7,40})'/m.exec(ps1)?.[1];
assert.ok(tag && commit, 'fetch-mpv.ps1 pins $MpvTag and $MpvCommit');
for (const arch of ['x86_64-v3', 'x86_64']) assert.match(ps1, new RegExp(`'${arch}'\\s*=\\s*'[0-9a-f]{64}'`), `SHA-256 for ${arch}`);
assert.match(ps1, /Get-FileHash -Algorithm SHA256/);
// Releases bundle the baseline build: the AVX2 one dies with an illegal instruction on Celeron/Pentium HTPCs.
assert.match(read('.github/workflows/release.yml'), /fetch-mpv\.ps1 -Generic/, 'release bundles the generic (non-AVX2) mpv');
assert.doesNotMatch(ps1, /releases\/latest/);
assert.ok(read('THIRD_PARTY_NOTICES.md').includes(`\`${tag}\` (\`git-${commit}\`)`), 'THIRD_PARTY_NOTICES.md names the pinned mpv build');
ok(`mpv pinned to shinchiro ${tag} (git-${commit})`);

// 4. electron-builder ships the licence folder and leaves the shinchiro extras out.
const eb = read('apps/desktop/electron-builder.yml');
assert.match(eb, /- from: out\/licenses\n\s+to: licenses/);
for (const x of ['d3dcompiler_43.dll', 'doc/**', 'installer/**', 'updater.bat', 'mpv-*register.bat']) assert.ok(eb.includes(`'!${x}'`), `vendor/mpv filter lacks !${x}`);
assert.match(read('apps/desktop/package.json'), /"build": "[^"]*tools\/release\/licenses\.mjs/);
ok('electron-builder.yml: resources/licenses and the vendor/mpv filter');

// 4b. Per-platform resources and the Linux packages. `section(k)`: the top-level YAML block `k:`.
const section = (k) => new RegExp(`^${k}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(eb)?.[1] ?? '';
const [top, win, linux, deb, appImage] = [eb.slice(0, eb.search(/^win:/m)), section('win'), section('linux'), section('deb'), section('appImage')];
assert.ok(win && linux && deb && appImage, 'electron-builder.yml has win, linux, deb and appImage sections');
assert.ok(!top.includes('vendor/mpv') && !linux.includes('vendor/mpv'), 'vendor/mpv is bundled only under win:');
assert.match(win, /- from: \.\.\/\.\.\/vendor\/mpv\n\s+to: mpv\n/);
assert.match(win, /- from: \.\.\/\.\.\/vendor\/vpn-helper\n\s+to: vpn-helper\n\s+filter:\n\s+- wicaby-mesh\.exe\n\s+- THIRD_PARTY_LICENSES\.txt\n/);
assert.match(linux, /- from: \.\.\/\.\.\/vendor\/vpn-helper\n\s+to: vpn-helper\n\s+filter:\n\s+- wicaby-mesh\n\s+- THIRD_PARTY_LICENSES\.txt\n/);
assert.ok(!top.includes('vendor/vpn-helper'), 'vpn-helper is bundled per platform');
for (const t of ['AppImage', 'deb', 'tar.gz']) assert.match(linux, new RegExp(`- target: ${t.replace('.', '\\.')}\\n`), `linux target ${t}`);
assert.match(linux, /^ {2}category: AudioVideo;Video;Player$/m);
assert.match(linux, /- x-scheme-handler\/magnet\n/);
assert.match(top, /protocols:\n\s+- name: Wicaby\n\s+schemes:\n\s+- wicaby\n/, 'x-scheme-handler/wicaby comes from protocols');
assert.match(deb, /- mpv \(>= 0\.37\)\n/);
assert.match(linux, /Actions: Home;Search;Downloads;Settings;\n/);
for (const [block, exec] of [[appImage, 'AppRun --no-sandbox'], [deb, '/opt/Wicaby/wicaby']]) {
  for (const [action, route] of [['Home', 'home'], ['Search', 'search'], ['Downloads', 'downloads'], ['Settings', 'settings']]) {
    assert.match(block, new RegExp(`^ {6}${action}: \\{ Name: ${action}, 'Name\\[fr\\]': [^,]+, Exec: ${exec} --wicaby-nav=/${route} \\}$`, 'm'), `${action} action (${exec})`);
  }
}
assert.match(read('apps/desktop/package.json'), /"dist:linux": "npm run build && electron-builder --linux"/);
ok('electron-builder.yml: mpv only on Windows, vpn-helper per platform, AppImage/deb/tar.gz with mpv >= 0.37');

// 4c. CI packages Linux, and a release publishes the Linux files next to the Windows ones.
const ci = read('.github/workflows/ci.yml');
const rel = read('.github/workflows/release.yml');
// Pinned, not ubuntu-latest: the libmpv addon built there must load on the oldest supported distro (#12).
assert.match(ci, /\n {2}desktop-linux:\n(?: {4}.*\n|\n)*? {4}runs-on: ubuntu-24\.04\n/);
assert.match(ci, /GOOS: linux\n\s+GOARCH: amd64\n\s+run: npm run build:mesh\n/);
assert.match(ci, /electron-builder --linux AppImage deb .*--publish never/);
assert.match(rel, /\n {2}linux:\n(?: {4}.*\n|\n)*? {4}runs-on: ubuntu-24\.04\n/);
assert.match(rel, /needs: \[preflight, windows, linux, android\]/);
assert.match(rel, /npm run dist:linux -w apps\/desktop -- --publish never/);
for (const ext of ['AppImage', 'deb', 'tar.gz']) assert.ok(rel.includes(`release/linux/*.${ext}`), `release.yml publishes *.${ext}`);
assert.match(read('THIRD_PARTY_NOTICES.md'), /#### mpv on Linux\r?\n\r?\nThe Linux packages do not contain mpv/);
ok('ci.yml desktop-linux job, release.yml linux job and its published files');

// 5. One version and one SPDX licence across the npm packages, and a CHANGELOG section for it.
const rootPkg = JSON.parse(read('package.json'));
const desktopPkg = JSON.parse(read('apps/desktop/package.json'));
assert.equal(desktopPkg.version, rootPkg.version);
assert.equal(rootPkg.license, 'GPL-3.0-or-later');
assert.equal(desktopPkg.license, 'GPL-3.0-or-later');
assert.ok(read('CHANGELOG.md').includes(`\n## [${rootPkg.version}] - `), `CHANGELOG.md has no [${rootPkg.version}] section`);
assert.ok(read('THIRD_PARTY_NOTICES.md').includes('`GPL-3.0-or-later`'));
ok(`version ${rootPkg.version}, GPL-3.0-or-later`);

console.log(`release-check: ${n} checks passed`);
