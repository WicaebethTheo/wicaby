// Self-check for the credential vault (src/main/core/vault.ts) on a mocked safeStorage:
// - a vault.bin written by the sync API (every build up to Electron 44) still opens with
//   the async API (Electron 45+), and the other way round;
// - the sync API stays the fallback when the async one is missing;
// - writes land in call order, shouldReEncrypt rewrites the blob, and an unavailable or
//   failing OS encryption never loses the in-memory state nor rejects.
// Usage: node tools/checks/vault-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-vault-'));
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    // The default storage forwards to whatever mock the check installs.
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const safeStorage = new Proxy({}, { get: (_t, k) => globalThis.__safeStorage?.[k], has: (_t, k) => k in (globalThis.__safeStorage ?? {}) });`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({
  entryPoints: [path.join(root, 'src/main/core/vault.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  plugins: [electronStub],
});
const { CredentialVault, linuxPasswordStore } = await import(pathToFileURL(out).href);

// ---- Mock OS encryption. 'v10' blobs are what the sync API has always written; the
// async API reads them and, after a key rotation, writes 'v11' and asks for a rewrite.
const KEYS = { v10: 0x5a, v11: 0x33 };
const seal = (ver, text) => Buffer.concat([Buffer.from(ver), Buffer.from(Buffer.from(text, 'utf8').map((c) => c ^ KEYS[ver]))]);
const open = (blob) => {
  const ver = blob.subarray(0, 3).toString();
  if (!(ver in KEYS)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
  return { ver, text: Buffer.from(blob.subarray(3).map((c) => c ^ KEYS[ver])).toString('utf8') };
};
const calls = [];
function syncStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (t) => (calls.push('encryptString'), seal('v10', t)),
    decryptString: (b) => (calls.push('decryptString'), open(b).text),
  };
}
function asyncStorage({ available = true, rotated = false, sync = true, failDecrypt = false, failEncrypt = false } = {}) {
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  return {
    ...(sync ? syncStorage({ available }) : {}),
    isAsyncEncryptionAvailable: async () => (await tick(), available),
    encryptStringAsync: async (t) => {
      calls.push('encryptStringAsync');
      await tick();
      if (failEncrypt) throw new Error('encryption failed');
      return seal(rotated ? 'v11' : 'v10', t);
    },
    decryptStringAsync: async (b) => {
      calls.push('decryptStringAsync');
      await tick();
      if (failDecrypt) throw new Error('async decryption failed');
      const { ver, text } = open(b);
      return { result: text, shouldReEncrypt: rotated && ver !== 'v11' };
    },
  };
}
// Silence the vault's expected warnings/errors (the logger writes to the console when not initialised).
const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error, console.info, console.debug];
  console.log = console.warn = console.error = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error, console.info, console.debug] = saved;
  }
};
const file = (name) => path.join(tmp, name);
const A = { userId: 'u1', userName: 'me', token: 'tok-a', origins: ['http://home.test:8096'] };
const B = { userId: 'u2', userName: 'you', token: 'tók-b ✓' };
const legacy = { 'server:A': A, 'torrents:qbittorrent': B };

// ---- 1. A vault.bin written by the sync API (Electron <= 44) opens with the async API.
{
  const f = file('legacy.bin');
  fs.writeFileSync(f, syncStorage().encryptString(JSON.stringify(legacy)));
  calls.length = 0;
  const v = await CredentialVault.open(f, asyncStorage());
  assert.deepEqual(v.get('server:A'), A);
  assert.deepEqual(v.get('torrents:qbittorrent'), B);
  assert.deepEqual(calls, ['decryptStringAsync'], 'the async API is preferred when present');
  assert.equal(v.busy, false, 'no rewrite without shouldReEncrypt');
}

// ---- 2. Round trip through the async API, then back through the sync one (downgrade).
{
  const f = file('roundtrip.bin');
  const v = await CredentialVault.open(f, asyncStorage());
  assert.equal(v.get('server:A'), undefined, 'a missing file opens empty');
  await v.set('server:A', A);
  await v.set('torrents:qbittorrent', B);
  assert.ok(!fs.existsSync(`${f}.tmp`), 'temp file left behind');
  const again = await CredentialVault.open(f, asyncStorage());
  assert.deepEqual(again.get('server:A'), A);
  assert.deepEqual(again.get('torrents:qbittorrent'), B);
  const viaSync = await CredentialVault.open(f, syncStorage());
  assert.deepEqual(viaSync.get('torrents:qbittorrent'), B, 'an async-written blob opens with the sync API');
}

// ---- 3. Electron without the async API: the sync one is used for both directions.
{
  const f = file('sync-only.bin');
  calls.length = 0;
  const v = await CredentialVault.open(f, syncStorage());
  await v.set('server:A', A);
  assert.deepEqual(calls, ['encryptString']);
  const again = await CredentialVault.open(f, syncStorage());
  assert.deepEqual(again.get('server:A'), A);
  assert.deepEqual(calls, ['encryptString', 'decryptString']);
}

// ---- 4. Async API with no sync fallback (Electron 46): legacy blobs still open.
{
  const f = file('async-only.bin');
  fs.writeFileSync(f, syncStorage().encryptString(JSON.stringify(legacy)));
  const v = await CredentialVault.open(f, asyncStorage({ sync: false }));
  assert.deepEqual(v.get('server:A'), A);
  await v.delete('server:A');
  const again = await CredentialVault.open(f, asyncStorage({ sync: false }));
  assert.equal(again.get('server:A'), undefined);
  assert.deepEqual(again.get('torrents:qbittorrent'), B);
}

// ---- 5. shouldReEncrypt: the blob is rewritten under the current key while opening.
{
  const f = file('rotate.bin');
  fs.writeFileSync(f, syncStorage().encryptString(JSON.stringify(legacy)));
  const v = await quiet(() => CredentialVault.open(f, asyncStorage({ rotated: true })));
  assert.deepEqual(v.get('server:A'), A);
  assert.equal(fs.readFileSync(f).subarray(0, 3).toString(), 'v11', 'not re-encrypted');
  const again = await CredentialVault.open(f, asyncStorage({ rotated: true }));
  assert.deepEqual(again.get('torrents:qbittorrent'), B);
}

// ---- 6. Writes are queued: the last change wins on disk even with uneven encryption delays.
{
  const f = file('order.bin');
  const v = await CredentialVault.open(f, asyncStorage());
  const done = [];
  for (let i = 0; i < 20; i++) done.push(v.set(`k${i % 3}`, { userId: String(i), userName: 'n', token: `t${i}` }));
  done.push(v.delete('k0'));
  assert.equal(v.busy, true);
  assert.equal(v.get('k2').token, 't17', 'memory is updated at once');
  assert.equal(v.get('k0'), undefined);
  await Promise.all(done);
  await v.flush();
  assert.equal(v.busy, false);
  const again = await CredentialVault.open(f, asyncStorage());
  assert.equal(again.get('k0'), undefined);
  assert.equal(again.get('k1').token, 't19');
  assert.equal(again.get('k2').token, 't17');
}

// ---- 7. Encryption unavailable: kept in memory, nothing written, never rejects.
for (const storage of [asyncStorage({ available: false }), syncStorage({ available: false })]) {
  const f = file(`unavailable-${Math.random().toString(36).slice(2)}.bin`);
  const v = await CredentialVault.open(f, storage);
  await quiet(() => v.set('server:A', A));
  assert.deepEqual(v.get('server:A'), A);
  assert.ok(!fs.existsSync(f), 'wrote a vault without OS encryption');
}

// ---- 8. A failing encryption is logged; the promise resolves and later writes still run.
{
  const f = file('fail-encrypt.bin');
  const storage = asyncStorage({ failEncrypt: true });
  const v = await CredentialVault.open(f, storage);
  await quiet(() => v.set('server:A', A));
  assert.ok(!fs.existsSync(f));
  storage.encryptStringAsync = async (t) => seal('v10', t);
  await v.set('torrents:qbittorrent', B);
  const again = await CredentialVault.open(f, asyncStorage());
  assert.deepEqual(again.get('server:A'), A);
  assert.deepEqual(again.get('torrents:qbittorrent'), B);
}

// ---- 9. Async decryption failing falls back to the sync API; garbage opens empty.
{
  const f = file('fallback.bin');
  fs.writeFileSync(f, syncStorage().encryptString(JSON.stringify(legacy)));
  const v = await quiet(() => CredentialVault.open(f, asyncStorage({ failDecrypt: true })));
  assert.deepEqual(v.get('server:A'), A);
  const g = file('garbage.bin');
  fs.writeFileSync(g, Buffer.from('not a vault'));
  for (const storage of [asyncStorage(), syncStorage(), asyncStorage({ sync: false })]) {
    const empty = await quiet(() => CredentialVault.open(g, storage));
    assert.equal(empty.get('server:A'), undefined);
  }
}

// ---- 9b. An unreadable vault is moved aside (timestamped), never overwritten by the next save.
{
  const sub = fs.mkdtempSync(path.join(tmp, 'unreadable-'));
  const f = path.join(sub, 'vault.bin');
  fs.writeFileSync(f, Buffer.from('not a vault'));
  const v = await quiet(() => CredentialVault.open(f, asyncStorage()));
  const aside = fs.readdirSync(sub).filter((n) => /^vault\.bin\.\d+\.unreadable$/.test(n));
  assert.equal(aside.length, 1, `moved aside: ${fs.readdirSync(sub)}`);
  await v.set('server:A', A);
  assert.equal(fs.readFileSync(path.join(sub, aside[0]), 'utf8'), 'not a vault', 'unreadable copy kept intact');
  assert.deepEqual((await CredentialVault.open(f, asyncStorage())).get('server:A'), A, 'new vault written next to it');
}

// ---- 9c. No usable OS key right now (Linux keyring not up yet): the vault stays in place, nothing overwrites it,
//          and the next start with the keyring back opens it.
{
  const sub = fs.mkdtempSync(path.join(tmp, 'keyring-late-'));
  const f = path.join(sub, 'vault.bin');
  const blob = Buffer.concat([Buffer.from('v11'), Buffer.from('sealed by the keyring')]);
  for (const storage of [
    { ...asyncStorage({ sync: false, failDecrypt: true }), getSelectedStorageBackend: () => 'basic_text' },
    asyncStorage({ sync: false, failDecrypt: true, available: false }),
  ]) {
    fs.writeFileSync(f, blob);
    const v = await quiet(() => CredentialVault.open(f, storage, { platform: 'linux', allowPlainText: () => true }));
    await quiet(() => v.set('server:A', A));
    assert.deepEqual(fs.readdirSync(sub), ['vault.bin'], 'not moved aside');
    assert.deepEqual(fs.readFileSync(f), blob, 'not overwritten');
    assert.deepEqual(v.get('server:A'), A, 'memory only meanwhile');
  }
}

// ---- 10. Without an explicit storage, Electron's safeStorage is used.
{
  globalThis.__safeStorage = asyncStorage();
  const f = file('default.bin');
  fs.writeFileSync(f, syncStorage().encryptString(JSON.stringify(legacy)));
  calls.length = 0;
  const v = await CredentialVault.open(f);
  assert.deepEqual(v.get('server:A'), A);
  assert.deepEqual(calls, ['decryptStringAsync']);
  delete globalThis.__safeStorage;
}

// ---- 11. Linux without a keyring (basic_text): memory only until the user accepts it; the
//          same backend name never changes anything on Windows.
{
  const keyring = (backend) => ({ ...asyncStorage(), getSelectedStorageBackend: () => backend });
  let allowed = false;
  const opts = (platform) => ({ platform, allowPlainText: () => allowed });
  const f = file('basic-text.bin');
  const v = await quiet(() => CredentialVault.open(f, keyring('basic_text'), opts('linux')));
  assert.equal(v.plainText, true);
  await quiet(() => v.set('server:A', A));
  assert.ok(!fs.existsSync(f), 'nothing written before consent');
  assert.deepEqual(v.get('server:A'), A, 'kept in memory');
  allowed = true;
  await v.save();
  assert.deepEqual((await CredentialVault.open(f, keyring('basic_text'), opts('linux'))).get('server:A'), A, 'written once accepted');
  allowed = false;
  await quiet(() => v.save());
  assert.ok(!fs.existsSync(f), 'removed when consent is withdrawn');
  for (const [backend, platform] of [['gnome_libsecret', 'linux'], ['kwallet6', 'linux'], ['basic_text', 'win32']]) {
    const g = file(`backend-${backend}-${platform}.bin`);
    const w = await CredentialVault.open(g, keyring(backend), opts(platform));
    assert.equal(w.plainText, false, `${backend} on ${platform}`);
    await w.set('server:A', A);
    assert.ok(fs.existsSync(g), `${backend} on ${platform} writes the vault`);
  }
  // A storage without the Linux-only call (Windows, older Electron) is never plain text.
  assert.equal((await CredentialVault.open(file('none.bin'), asyncStorage(), opts('linux'))).plainText, false);
}

// Keyring on desktops Chromium does not know: libsecret is asked for, known desktops and a user switch are left alone.
{
  const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'Hyprland' }, []), 'gnome-libsecret');
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'sway' }, []), 'gnome-libsecret');
  assert.equal(linuxPasswordStore({ ...bus }, []), 'gnome-libsecret');
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, []), null);
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'KDE' }, []), null);
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, []), null);
  assert.equal(linuxPasswordStore({ ...bus, XDG_CURRENT_DESKTOP: 'Hyprland' }, ['--password-store=basic']), null);
  assert.equal(linuxPasswordStore({ XDG_CURRENT_DESKTOP: 'Hyprland' }, []), null, 'no session bus');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('vault-check: ok');
