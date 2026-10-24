import fs from 'node:fs';
import { safeStorage } from 'electron';
import { logger } from './log';

const log = logger.scope('vault');

export interface StoredCredential {
  userId: string;
  userName: string;
  token: string;
}

// The slice of Electron's safeStorage the vault uses. The async half is optional:
// it is preferred when present, and the sync API (deprecated in Electron 45,
// removed in 46) is the fallback. Blobs written by either decrypt with the other.
export interface VaultStorage {
  isEncryptionAvailable?(): boolean;
  encryptString?(plainText: string): Buffer;
  decryptString?(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

export interface VaultOptions {
  platform?: NodeJS.Platform;
  // The user chose to keep credentials on disk although Linux has no keyring (basic_text).
  allowPlainText?: () => boolean;
}

// Chromium picks the Linux keyring from XDG_CURRENT_DESKTOP and falls back to basic_text on desktops it does not
// know (Hyprland, Sway, niri...), even with gnome-keyring or KeePassXC serving the Secret Service: sign-ins were then
// lost on every quit. Ask for libsecret there; Chromium still drops to basic_text when no Secret Service answers.
// A --password-store given by the user wins. Read before app ready (index.ts).
const KNOWN_DESKTOPS = /\b(gnome|kde|xfce|unity|pantheon|deepin|cinnamon|x-cinnamon|budgie|lxqt|ukui)\b/i;
export function linuxPasswordStore(env: NodeJS.ProcessEnv, argv: string[]): 'gnome-libsecret' | null {
  if (argv.some((a) => a.startsWith('--password-store'))) return null;
  if (!env.DBUS_SESSION_BUS_ADDRESS) return null;
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`;
  return KNOWN_DESKTOPS.test(desktop.replaceAll(':', ' ')) ? null : 'gnome-libsecret';
}

const hasAsync = (s: VaultStorage): boolean =>
  typeof s.isAsyncEncryptionAvailable === 'function' && typeof s.encryptStringAsync === 'function' && typeof s.decryptStringAsync === 'function';

// Access tokens live in an OS-encrypted blob (safeStorage, DPAPI on Windows), bound
// to the Windows user account. Emby Theater kept them as plain JSON in LocalSettings.
// Linux without a keyring (backend basic_text) only obfuscates with a fixed key: the vault then
// stays in memory, unless allowPlainText() says the user accepted it (Confidentialité pane).
//
// Open it with `await CredentialVault.open(file)` after app.whenReady(): the async
// safeStorage API only works once the app is ready. Reads are synchronous from
// memory. A change applies in memory at once and is persisted in call order; the
// returned promise settles once it is on disk (or failed, which is logged) and
// never rejects.
export class CredentialVault {
  private entries: Record<string, StoredCredential> = {};
  private writes: Promise<void> = Promise.resolve();
  private pending = 0;
  // Set when an unreadable vault could not be moved aside: it is then never overwritten.
  private readOnly = false;

  private constructor(
    private readonly filePath: string,
    private readonly storage: VaultStorage,
    private readonly opts: VaultOptions,
  ) {}

  static async open(filePath: string, storage: VaultStorage = safeStorage, opts: VaultOptions = {}): Promise<CredentialVault> {
    const vault = new CredentialVault(filePath, storage, opts);
    await vault.load();
    return vault;
  }

  private async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) return;
    let reEncrypt = false;
    let blob: Buffer | null = null;
    try {
      blob = fs.readFileSync(this.filePath);
      const { result, shouldReEncrypt } = await this.decrypt(blob);
      this.entries = JSON.parse(result) as Record<string, StoredCredential>;
      reEncrypt = shouldReEncrypt;
    } catch (err) {
      // No usable key right now (Linux keyring not up yet at login, unlock prompt dismissed: basic_text cannot
      // open a keyring 'v11' blob) is not a corrupt file: it stays in place for the next start, memory only meanwhile.
      if (blob && (!(await this.available()) || (this.plainText && blob.subarray(0, 3).toString() === 'v11'))) {
        this.readOnly = true;
        this.entries = {};
        log.warn('credential vault not readable with the current OS key, kept in place; credentials are in memory only for now', err);
        return;
      }
      // Kept aside rather than overwritten by the next save: another Windows user or a
      // restored profile key may still open it.
      const aside = `${this.filePath}.${Date.now()}.unreadable`;
      try {
        fs.renameSync(this.filePath, aside);
        log.warn(`Could not decrypt credential vault, moved to ${aside}, starting empty`, err);
      } catch (renameErr) {
        this.readOnly = true;
        log.error(`Could not decrypt (${String(err)}) or move the credential vault, credentials are kept in memory only`, renameErr);
      }
      this.entries = {};
      return;
    }
    // The OS key rotated: rewrite the blob under the current one.
    if (reEncrypt) {
      log.info('re-encrypting the credential vault');
      await this.persist();
    }
  }

  private async decrypt(blob: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const s = this.storage;
    if (hasAsync(s)) {
      try {
        return await s.decryptStringAsync!(blob);
      } catch (err) {
        // A blob the async path cannot read may still open with the sync one, while it exists.
        if (typeof s.decryptString !== 'function') throw err;
        log.warn('async decryption failed, retrying with the sync API', err);
      }
    }
    if (typeof s.decryptString !== 'function') throw new Error('safeStorage has no decryption API');
    return { result: s.decryptString(blob), shouldReEncrypt: false };
  }

  // True when the OS "encryption" is a fixed key anyone can undo (Linux, no keyring).
  get plainText(): boolean {
    return (this.opts.platform ?? process.platform) === 'linux' && this.storage.getSelectedStorageBackend?.() === 'basic_text';
  }

  private async available(): Promise<boolean> {
    const s = this.storage;
    try {
      if (hasAsync(s)) return await s.isAsyncEncryptionAvailable!();
      return typeof s.isEncryptionAvailable === 'function' && s.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private async encrypt(plainText: string): Promise<Buffer | null> {
    const s = this.storage;
    if (hasAsync(s)) {
      if (await s.isAsyncEncryptionAvailable!()) return s.encryptStringAsync!(plainText);
    } else if (typeof s.isEncryptionAvailable === 'function' && typeof s.encryptString === 'function' && s.isEncryptionAvailable()) {
      return s.encryptString(plainText);
    }
    return null;
  }

  // Queues a save behind the previous ones, so the last change always wins on disk.
  private persist(): Promise<void> {
    this.pending++;
    const json = JSON.stringify(this.entries);
    const run = async () => {
      try {
        if (this.readOnly) return;
        if (this.plainText && !this.opts.allowPlainText?.()) {
          // Not accepted (or no longer): nothing stays on disk.
          fs.rmSync(this.filePath, { force: true });
          log.warn('no OS keyring (basic_text), credentials are kept in memory only');
          return;
        }
        const blob = await this.encrypt(json);
        if (!blob) {
          log.error('OS encryption unavailable, credentials are kept in memory only');
          return;
        }
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, blob);
        fs.renameSync(tmp, this.filePath);
      } catch (err) {
        log.error('Could not save the credential vault', err);
      } finally {
        this.pending--;
      }
    };
    this.writes = this.writes.then(run);
    return this.writes;
  }

  // Whether a change is still being written.
  get busy(): boolean {
    return this.pending > 0;
  }

  // Settles once every queued change is on disk (or failed). Never rejects.
  flush(): Promise<void> {
    return this.writes;
  }

  // Writes the current entries again, e.g. after the plain-text choice changed.
  save(): Promise<void> {
    return this.persist();
  }

  // Another file under the same OS protection as the vault (the IPTV caches hold playlist URLs that carry
  // credentials). Null when nothing can encrypt: the caller then keeps the data in memory only.
  async seal(plainText: string): Promise<Buffer | null> {
    if (this.plainText && !this.opts.allowPlainText?.()) return null;
    return this.encrypt(plainText).catch(() => null);
  }

  async unseal(blob: Buffer): Promise<string | null> {
    return this.decrypt(blob).then(
      (r) => r.result,
      () => null,
    );
  }

  get(serverId: string): StoredCredential | undefined {
    return this.entries[serverId];
  }

  set(serverId: string, credential: StoredCredential): Promise<void> {
    this.entries[serverId] = credential;
    return this.persist();
  }

  delete(serverId: string): Promise<void> {
    delete this.entries[serverId];
    return this.persist();
  }
}
