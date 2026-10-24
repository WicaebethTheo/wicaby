// Comic formats beyond CBZ (desktop comics/formats.ts, archive*.ts, comic-service.ts): format detection by
// magic bytes, EPUB reading order, the libarchive worker (RAR 4 and 5, 7z, tar) with its limits, and then
// ComicService itself against the Emby mock: every fixture book's page list, first and last page, and cover.
// PDF pages are drawn by pdf.js in a hidden window in the app; here a pdf.js (Node) stand-in reads the page
// count, sizes and image of each page through ComicService.file, the route that window reads.
// Usage: node tools/checks/comic-formats-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { comicPage, png, zip } from '../mock-server/cbz-fixture.mjs';
import { epub, pdf, rar4, rar5, sevenZip, tar } from '../mock-server/comic-formats-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const desktop = path.join(root, 'apps', 'desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const F = await imp('apps/desktop/src/main/comics/formats.ts');
const { COVER_EXTS } = await imp('apps/desktop/src/shared/comic-cover.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-formats-'));
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);

const pages = (count, hue = [90, 140, 220]) => Array.from({ length: count }, (_, i) => ({ name: `Tome/${String(i + 1).padStart(2, '0')}.png`, data: comicPage(i + 1, hue, 60, 90) }));

try {
  // 1. Format by magic bytes, whatever the name says; the extension lists agree.
  const three = pages(3);
  const byFormat = { zip: zip(three), epub: epub(three.map((p) => p.data)), rar: rar5(three), '7z': sevenZip(three), tar: tar(three), pdf: pdf(three.map((p) => p.data)) };
  for (const [want, bytes] of Object.entries(byFormat)) assert.equal(F.sniff(bytes.subarray(0, 1024)), want, `sniff ${want}`);
  assert.equal(F.sniff(rar4(three).subarray(0, 1024)), 'rar', 'RAR 4 marker');
  assert.equal(F.sniff(Buffer.concat([Buffer.from('junk\n'), byFormat.pdf]).subarray(0, 1024)), 'pdf', 'PDF header after junk');
  assert.equal(F.sniff(Buffer.from('\0'.repeat(60) + 'BOOKMOBI', 'latin1')), null, 'MOBI is not read');
  assert.equal(F.sniff(Buffer.alloc(0)), null, 'empty file');
  assert.deepEqual([...F.COMIC_EXTS].sort(), [...COVER_EXTS].sort(), 'reader and cover extension lists are the same');
  assert.equal(F.formatOfExt('CBR'), 'rar');
  assert.equal(F.formatOfExt('mobi'), null);
  // Android (core comics/ComicFormats.kt BY_EXT): the same extensions, mapped to the same formats.
  const kt = fs.readFileSync(path.join(root, 'apps/android/core/src/main/java/com/wika/wicaby/core/comics/ComicFormats.kt'), 'utf8');
  const KT = { ZIP: 'zip', EPUB: 'epub', RAR: 'rar', SEVEN_Z: '7z', TAR: 'tar', PDF: 'pdf' };
  const android = Object.fromEntries([.../"(\w+)" to ComicFormat\.(\w+)/g[Symbol.matchAll](/BY_EXT = mapOf\(([\s\S]*?)\n    \)/.exec(kt)?.[1] ?? '')].map((m) => [m[1], KT[m[2]]]));
  assert.deepEqual(android, Object.fromEntries(F.COMIC_EXTS.map((e) => [e, F.formatOfExt(e)])), 'Android ComicFormats.BY_EXT matches desktop formats.ts');
  ok('magic bytes decide the format; reader and cover extension lists agree, desktop and Android');

  // 2. Extraction names cannot leave their folder, and sort as the archive names do.
  for (const evil of ['../x.png', '..\\..\\x.png', '/etc/x.png', 'C:\\Windows\\x.png', 'a/../../x.png', 'a\0b.png']) {
    const flat = F.flatName(7, evil);
    assert.ok(!/[\\/]/.test(flat) && !flat.includes('..') && !flat.includes('\0') && !/^[a-z]:/i.test(flat), `${JSON.stringify(evil)} -> ${flat}`);
    assert.equal(path.resolve(tmp, flat).startsWith(tmp + path.sep), true);
  }
  assert.equal(F.archiveName(F.flatName(3, 'Tome 1/Page 02.png')), 'Tome 1/Page 02.png', 'flat name back to the archive name');
  ok('flattened names stay in the extraction folder');

  // 3. EPUB: spine order (images named in reverse on purpose), SVG pages, cover-image, text books.
  {
    const opf = '<package><metadata><dc:title>Planches &amp; cie</dc:title><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="c" href="img/c.jpg" media-type="image/jpeg" properties="cover-image"/><item id="p2" href="xhtml/p2.xhtml"/><item id="p1" href="xhtml/p1.xhtml"/><item id="n" href="nav.xhtml" properties="nav"/></manifest><spine><itemref idref="p1"/><itemref idref="n" linear="no"/><itemref idref="p2"/></spine></package>';
    const pkg = F.epubPackage(opf, 'OPS/content.opf');
    assert.deepEqual(pkg.spine, ['OPS/xhtml/p1.xhtml', 'OPS/xhtml/p2.xhtml'], 'spine order, linear="no" skipped, paths resolved');
    assert.equal(pkg.cover, 'OPS/img/c.jpg');
    assert.equal(pkg.title, 'Planches & cie');
    assert.equal(pkg.fixedLayout, true);
    assert.equal(F.epubRootfile('<container><rootfiles><rootfile full-path="OPS/content.opf" media-type="x"/></rootfiles></container>'), 'OPS/content.opf');
    assert.equal(F.epubPageImage('<html><body><img src="../img/p%201.jpg"/></body></html>', 'OPS/xhtml/p1.xhtml', true), 'OPS/img/p 1.jpg');
    assert.equal(F.epubPageImage('<svg><image xlink:href="../img/2.png"/></svg>', 'OPS/xhtml/p2.xhtml', true), 'OPS/img/2.png');
    assert.equal(F.epubPageImage(`<body><img src="a.png"/><p>${'mot '.repeat(80)}</p></body>`, 'x.xhtml', false), null, 'reflowable page with text: a text page');
    assert.equal(F.epubPageImage(`<body><img src="a.png"/><p>${'mot '.repeat(80)}</p></body>`, 'x.xhtml', true), 'a.png', 'fixed layout: the image counts');
    assert.equal(F.epubPageImage('<img src="https://example.invalid/a.png"/>', 'x.xhtml', true), null, 'remote images are not pages');
    // A hostile page of '<' with no '>' is stripped in linear time (the old /<[^>]*>/ took minutes on 4 MiB).
    const t0 = performance.now();
    F.epubPageImage(`<body>${'<'.repeat(200_000)}`, 'x.xhtml', false);
    assert.ok(performance.now() - t0 < 1000, `tag strip is linear (${Math.round(performance.now() - t0)} ms)`);
    assert.equal(F.isTextBook(10, 4), true);
    assert.equal(F.isTextBook(10, 5), false);
  }
  ok('EPUB container, package, spine and page images');

  // 4. The archive worker, bundled as for the app (build-main.mjs) and started from its source.
  const workerFile = path.join(tmp, 'archive-worker.cjs');
  await build({ entryPoints: [path.join(desktop, 'src/main/comics/archive-worker.ts')], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: workerFile, logLevel: 'error' });
  const worker = { script: fs.readFileSync(workerFile, 'utf8'), evaluate: true, wasm: fs.readFileSync(require.resolve('libarchive-wasm/dist/libarchive.wasm')) };
  const bundle = path.join(tmp, 'comics.mjs');
  await build({
    stdin: {
      contents: ["export { runArchiveJob } from './main/comics/archive-job';", "export { ComicService } from './main/comics/comic-service';", "export { t } from './main/i18n';"].join('\n'),
      resolveDir: path.join(desktop, 'src'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'error',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
          // fetchFollowing without Electron's net: plain fetch with the auth headers (no redirects in the mock).
          b.onResolve({ filter: /connection\/api-client$/ }, () => ({ path: 'api-client', namespace: 'stub' }));
          b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
            contents: `export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'en', getPath: () => '' };
              export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }) };
              export class BrowserWindow {}
              export default { app, nativeImage };`,
          }));
          b.onLoad({ filter: /^api-client$/, namespace: 'stub' }, () => ({
            contents: 'export const fetchFollowing = (api, url, init) => fetch(url, { method: init.method, headers: { ...init.headers, ...init.auth }, signal: init.signal });',
          }));
        },
      },
    ],
  });
  const { runArchiveJob, ComicService, t } = await import(pathToFileURL(bundle).href);
  const job = (j, timeout) => runArchiveJob(worker.script, true, { wasm: worker.wasm, ...j }, timeout);
  const LIMITS = { maxEntry: 64 * 1024 * 1024, maxTotal: 1024 ** 3, maxEntries: 200_000 };
  const extract = async (name, bytes, limits = LIMITS) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, bytes);
    const dir = path.join(tmp, `${name}.d`);
    const r = await job({ mode: 'extract', file, dir, maxArchive: 1024 ** 3, limits });
    return { dir, names: r.names };
  };

  const five = [...pages(5), { name: '__MACOSX/._01.png', data: Buffer.from('x') }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') }, { name: 'notes.txt', data: Buffer.from('n') }];
  for (const [label, bytes] of [['RAR 5', rar5(five)], ['RAR 4', rar4(five)], ['7z', sevenZip(five)], ['tar', tar(five)]]) {
    const { dir, names } = await extract(`book-${label.replace(/\W/g, '')}`, bytes);
    assert.deepEqual(names.map(F.archiveName), ['Tome/01.png', 'Tome/02.png', 'Tome/03.png', 'Tome/04.png', 'Tome/05.png', 'ComicInfo.xml'], `${label}: pages and ComicInfo only`);
    assert.ok(fs.readFileSync(path.join(dir, names[0])).equals(five[0].data), `${label}: page 1 bytes`);
    assert.ok(!fs.existsSync(`${dir}.part`), `${label}: no .part folder left`);
    const cover = await job({ mode: 'cover', data: bytes, partial: false, limits: LIMITS });
    assert.ok(Buffer.from(cover.data).equals(five[0].data), `${label}: cover is page 1`);
    // A whole local book longer than the cover's byte budget still gives its cover (the walk stops at the cap).
    const capped = await job({ mode: 'cover', data: bytes, partial: false, limits: { ...LIMITS, maxTotal: five[0].data.length + 1 } });
    assert.ok(Buffer.from(capped.data).equals(five[0].data), `${label}: cover found before the size cap`);
  }
  ok('RAR 5, RAR 4, 7z and tar: pages extracted in order, cover found');

  {
    // A cover from the first bytes only (remote: one Range request): page 1 whole, page 2 cut.
    const big = rar5(pages(3).map((p, i) => (i === 0 ? { ...p, name: 'Tome/02.png' } : i === 1 ? { ...p, name: 'Tome/01.png' } : p)));
    const cut = big.subarray(0, big.indexOf(pages(3)[1].data) + 100);
    const cover = await job({ mode: 'cover', data: cut, partial: true, limits: LIMITS });
    assert.equal(cover.name, 'Tome/02.png', 'only the entries the prefix holds whole are candidates');
    const noneYet = await job({ mode: 'cover', data: big.subarray(0, 40), partial: true, limits: LIMITS });
    assert.ok('none' in noneYet, 'a prefix holding no whole page gives no cover');
  }
  ok('partial archive (Range prefix) cover');

  // Limits: a forged size, too many entries, path names, encryption, the archive cap.
  const rejects = async (p, code, msg) => {
    await assert.rejects(p, (err) => err.code === code, msg);
  };
  await rejects(extract('forged.cbr', rar5([{ name: 'Tome/01.png', data: three[0].data, size: 65 * 1024 * 1024 }])), 'tooLarge', 'an entry announcing 65 MiB');
  await rejects(extract('count.cbr', rar5(pages(5)), { ...LIMITS, maxEntries: 3 }), 'tooLarge', 'more entries than the cap');
  await rejects(extract('total.cbr', rar5(pages(5)), { ...LIMITS, maxTotal: 600 }), 'tooLarge', 'more bytes than the book cap');
  await rejects(extract('locked.cbr', rar5(pages(2), { encrypted: true })), 'encrypted', 'an encrypted RAR is refused');
  await rejects(job({ mode: 'extract', file: path.join(tmp, 'book-RAR5'), dir: path.join(tmp, 'cap.d'), maxArchive: 100, limits: LIMITS }), 'tooLarge', 'an archive past the in-memory cap');
  {
    // A worker cut off by the timeout never cleans up itself: its half-written folder goes with it.
    const dir = path.join(tmp, 'slow.d');
    fs.mkdirSync(`${dir}.part`, { recursive: true });
    fs.writeFileSync(path.join(`${dir}.part`, '0001.png'), 'half');
    await rejects(job({ mode: 'extract', file: path.join(tmp, 'book-RAR5'), dir, maxArchive: 1024 ** 3, limits: LIMITS }, 1), 'tooLarge', 'a timed-out extract');
    assert.ok(!fs.existsSync(`${dir}.part`), 'no .part folder left after a timeout');
  }
  {
    const { dir, names } = await extract('evil.cbt', tar([{ name: '../escape.png', data: three[0].data }, { name: '/abs/02.png', data: three[1].data }]));
    // '..' reads as a hidden path part and is skipped; the absolute name is flattened into the folder.
    assert.deepEqual(names.map(F.archiveName), ['abs/02.png'], 'the absolute name kept, flattened');
    assert.ok(!fs.existsSync(path.join(tmp, 'escape.png')), 'nothing written outside the folder');
    for (const f of names) assert.ok(fs.existsSync(path.join(dir, f)));
  }
  ok('limits: forged entry size, entry count, total size, encrypted RAR, archive size, ../ names');

  // A compressed 7z (LZMA2), when a bsdtar that writes 7z is at hand (Windows 10+, libarchive-tools on Linux).
  {
    const src = path.join(tmp, 'lzma');
    fs.mkdirSync(src);
    for (const p of pages(4)) fs.writeFileSync(path.join(src, path.basename(p.name)), p.data);
    let made = false;
    try {
      // Windows' own tar.exe is bsdtar (Git's tar on the PATH is GNU tar, which cannot write 7z). Names listed
      // sorted: bsdtar walks '.' in directory order, which btrfs returns reversed.
      execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar', ['--format', '7zip', '--options', '7zip:compression=lzma2', '-cf', path.join(tmp, 'lzma.cb7'), '-C', src, ...fs.readdirSync(src).sort()], { stdio: 'ignore' });
      made = true;
    } catch {
      console.log('comic-formats-check: no bsdtar that writes 7z here, compressed 7z case skipped');
    }
    if (made) {
      const { names } = await extract('lzma.cb7.copy', fs.readFileSync(path.join(tmp, 'lzma.cb7')));
      assert.deepEqual(names.map(F.archiveName).map((x) => path.basename(x)), ['01.png', '02.png', '03.png', '04.png'], 'LZMA2 7z');
      ok('compressed (LZMA2) 7z made by bsdtar');
    }
  }

  // 5. ComicService against the Emby mock: every book, opened and covered.
  const E = await imp('tools/mock-server/mock-emby.mjs');
  E.hooks.log = () => {};
  const server = http.createServer(E.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/emby`;
  try {
    const login = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="formats-check", Version="1"' },
      body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
    }).then((r) => r.json());
    const H = { 'X-Emby-Token': login.AccessToken };
    const uid = login.User.Id;
    const api = {
      kind: 'emby',
      address: base,
      url: (p) => base + p,
      authHeaders: () => H,
      get: async (p) => (await fetch(base + p, { headers: H })).json(),
      post: async () => ({}),
    };
    const connection = { primaryId: 'srv1', apiFor: () => api, onlineApi: () => api, sessionFor: () => ({ user: { id: uid }, server: { id: 'srv1' } }), userIdFor: () => uid };
    const downloads = { findDone: () => undefined, queueUserData: () => undefined };
    // pdf.js in Node for the PDF renderer window: reads the book through ComicService.file, as pdf.html does.
    const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    let svc;
    const pdfData = async (url) => {
      const [, sid, id] = /^wicaby-media:\/\/comic-file\/([^/]+)\/([^/]+)$/.exec(url);
      const chunks = [];
      for (let at = 0, total = Infinity; at < total; ) {
        const res = await svc.file(id, `bytes=${at}-${at + 65535}`, sid);
        assert.equal(res.status, 206, 'comic-file answers a range');
        total = Number(/\/(\d+)$/.exec(res.headers.get('content-range'))[1]);
        const buf = Buffer.from(await res.arrayBuffer());
        chunks.push(buf);
        at += buf.length;
      }
      return new Uint8Array(Buffer.concat(chunks));
    };
    const pdfEngine = {
      async info(url) {
        const task = pdfjs.getDocument({ data: await pdfData(url), verbosity: 0 });
        const doc = await task.promise;
        const sizes = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
          sizes.push([vp.width, vp.height]);
        }
        await task.destroy();
        return { count: sizes.length, sizes };
      },
      async render(url, index, height) {
        const task = pdfjs.getDocument({ data: await pdfData(url), verbosity: 0 });
        const doc = await task.promise;
        const ops = await (await doc.getPage(index + 1)).getOperatorList();
        await task.destroy();
        assert.ok(ops.fnArray.includes(pdfjs.OPS.paintImageXObject), `PDF page ${index + 1} paints its image`);
        return Buffer.from(`pdf-page-${index}-${height}`);
      },
    };
    const service = (dir) => new ComicService(path.join(tmp, dir), connection, downloads, () => 2 * 1024 ** 3, { archiveWorker: () => worker, pdf: pdfEngine });

    const expected = (c, i) => (i + 1 === c.spread ? comicPage(i + 1, c.hue, 1200, 900) : c.tall ? comicPage(i + 1, c.hue, 500, 1800) : comicPage(i + 1, c.hue));
    const WANT = { 'comic-1': 24, 'comic-2': 14, 'comic-3': 6, 'comic-4': 8, 'comic-5': 5, 'comic-6': 5, 'comic-7': 5, 'comic-8': 4, 'comic-9': 5 };
    for (const [id, count] of Object.entries(WANT)) {
      const c = E.COMICS[id];
      const ext = c.ext ?? 'cbz';
      // Remote cover first (nothing local yet), from a fresh cache.
      svc = service(`remote-${id}`);
      const remote = await svc.cover(id, 'v1', false, 'srv1');
      if (ext === 'cb7') assert.equal(remote, null, `${id}: no remote 7z cover (index at the end)`);
      else if (ext === 'pdf') assert.equal(remote?.data.toString(), 'pdf-page-0-660', `${id}: PDF cover is page 1 drawn at card height`);
      else assert.ok(remote?.data.equals(expected(c, 0)), `${id} (${ext}): remote cover is page 1`);

      svc = service(`open-${id}`);
      const info = await svc.open(id, 'srv1');
      assert.equal(info.pageCount, count, `${id} (${ext}): ${count} pages`);
      assert.equal(info.pages.length, count);
      if (ext === 'pdf') {
        assert.deepEqual(info.pages[2], { width: 1200, height: 900 }, `${id}: the spread's size`);
        assert.equal((await svc.page(id, 0, false, 'srv1')).data.toString(), 'pdf-page-0-2400', `${id}: page drawn at reading height`);
        assert.equal((await svc.page(id, 3, true, 'srv1')).data.toString(), 'pdf-page-3-240', `${id}: thumbnail drawn small`);
      } else {
        const [w, h] = c.tall ? [500, 1800] : [600, 900];
        assert.deepEqual([info.pages[0].width, info.pages[0].height], [w, h], `${id}: page 1 size from its header`);
        assert.ok((await svc.page(id, 0, false, 'srv1')).data.equals(expected(c, 0)), `${id}: first page`);
        assert.ok((await svc.page(id, count - 1, false, 'srv1')).data.equals(expected(c, count - 1)), `${id}: last page (reading order)`);
      }
      assert.equal(await svc.page(id, count, false, 'srv1'), null, `${id}: no page past the end`);
      if (['cbr', 'cb7', 'cbt'].includes(ext)) {
        assert.ok(fs.statSync(path.join(tmp, `open-${id}`, `srv1-${id}.d`)).isDirectory(), `${id}: extracted once`);
        assert.ok(!fs.existsSync(path.join(tmp, `open-${id}`, `srv1-${id}.book`)), `${id}: the cached archive is dropped after extraction`);
      }
      // Local cover once the book is here (7z included).
      const local = await svc.cover(id, 'v2', false, 'srv1');
      if (ext === 'pdf') assert.equal(local?.data.toString(), 'pdf-page-0-660');
      else assert.ok(local?.data.equals(expected(c, 0)), `${id}: local cover is page 1`);
      // A second service on the same cache: an extracted book opens without the network.
      if (ext === 'cbr') assert.equal((await service(`open-${id}`).open(id, 'srv1')).pageCount, count, `${id}: reopened from its folder`);
      console.log(`comic-formats-check: ${id} (${ext}) ${count} pages, page 1, last page and covers OK`);
    }
    assert.equal(E.COMICS['comic-3'].ad, true, 'comic-3 carries a Deleted ad page');
    ok('ComicService: every format opened, read and covered (ComicInfo Deleted page dropped in comic-3)');

    svc = service('refused');
    await assert.rejects(svc.open('comic-10', 'srv1'), (e) => e.message === t('errors.comics.textBook'), 'a text EPUB');
    await assert.rejects(svc.open('comic-11', 'srv1'), (e) => e.message === t('errors.comics.unsupported'), 'a .mobi');
    ok('text EPUB and MOBI are refused with their messages');
  } finally {
    server.close();
  }

  // 6. EPUB DRM and a ZIP-named RAR (the bytes win over the extension), straight from files.
  {
    const svcLocal = (file) => new ComicService(path.join(tmp, 'local'), { primaryId: 'srv1', onlineApi: () => null }, { findDone: () => ({ filePath: file, item: { Id: 'x', Name: 'x', Type: 'Book' } }) }, () => 1024 ** 3, { archiveWorker: () => worker, pdf: {} });
    const drm = path.join(tmp, 'drm.epub');
    fs.writeFileSync(drm, epub(pages(3).map((p) => p.data), { drm: true }));
    await assert.rejects(svcLocal(drm).open('drm', 'srv1'), (e) => e.message === t('errors.comics.encrypted'), 'DRM EPUB');
    const misnamed = path.join(tmp, 'misnamed.cbz');
    fs.writeFileSync(misnamed, rar5(pages(4)));
    assert.equal((await svcLocal(misnamed).open('misnamed', 'srv1')).pageCount, 4, 'a RAR named .cbz opens as RAR');
    ok('DRM EPUB refused; a misnamed archive opens by its magic bytes');
  }
  console.log(`comic-formats-check: ${n} groups OK`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
