import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { logger } from '../core/log';
import { t } from '../i18n';

const log = logger.scope('mpv');

// Both transports (this one and libmpv-controller.ts): a ping every 5 s, 10 s without an answer is a hang.
export const PING_MS = 5000;
export const HUNG_MS = 10_000;
// Windows: TerminateProcess whatever the signal (SIGTERM is Node's default). Unix: a hung mpv may never act on SIGTERM.
const KILL_SIGNAL = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL';

// Pings mpv from its own thread over a second pipe client and kills it when it stops
// answering. mpv's window is a child of ours, so a hung mpv can block our main thread
// on window messages, and a main-thread timer would never fire.
const WATCHDOG = `
const { parentPort, workerData: w } = require('node:worker_threads');
const net = require('node:net');
let last = Date.now(), tick = last, buf = '';
const sock = net.connect(w.pipe, () => sock.write('{"command":["disable_event","all"]}\\n'));
sock.setEncoding('utf8');
sock.on('error', () => {});
sock.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try { if (JSON.parse(line).request_id === 1) last = Date.now(); } catch {}
  }
});
const timer = setInterval(() => {
  const now = Date.now();
  // A late tick means the machine slept or this thread stalled: restart the clock.
  if (now - tick > w.ping * 3) last = now;
  tick = now;
  if (now - last > w.hung) {
    clearInterval(timer);
    parentPort.postMessage('hung');
    try { process.kill(w.pid, w.signal); } catch {}
    sock.destroy();
    return;
  }
  sock.write('{"command":["get_property","pid"],"request_id":1}\\n');
}, w.ping);
`;

// One line of mpv's log, as both transports read it (stderr here, mpv_request_log_messages in-process): whether it
// is worth the debug log, and the output failure it reports, if any.
export function classifyMpvLog(line: string): { log: boolean; signal: 'ao-failed' | 'vo-failed' | null } {
  return {
    // FFmpeg repeats this for most DV releases (RPU per slice); harmless, it keeps the last RPU.
    log: line.trim() !== '' && !line.includes('Multiple Dolby Vision RPUs found in one AU'), // i18n-ignore: an FFmpeg log line, matched verbatim
    signal: line.includes('Failed to initialize audio driver')
      ? 'ao-failed'
      : line.includes('Error opening/initializing the selected video_out')
        ? 'vo-failed'
        : null,
  };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// mpv candidates in search order: explicit setting, bundled copy, dev vendor folder (vendor/mpv at
// the repo root, two levels above apps/desktop), PATH, then common install locations. Linux runs a
// system mpv (a bundled or vendor copy is honoured when present). index.ts runs the first valid one.
export function mpvCandidates(configured: string, resourcesPath: string, appRoot: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') {
    const dirs = [...(process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/')), '/usr/bin', '/usr/local/bin', '/app/bin'];
    return [
      configured,
      path.posix.join(resourcesPath, 'mpv', 'mpv'),
      path.posix.join(appRoot, '..', '..', 'vendor', 'mpv', 'mpv'),
      ...dirs.map((dir) => path.posix.join(dir, 'mpv')),
    ];
  }
  return [
    configured,
    path.join(resourcesPath, 'mpv', 'mpv.exe'),
    path.join(appRoot, '..', '..', 'vendor', 'mpv', 'mpv.exe'),
    ...(process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'mpv.exe')),
    path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'mpv', 'mpv.exe'),
    'C:\\Program Files\\mpv\\mpv.exe',
  ];
}

// Unix: one probe per path and mtime, shared by the settings page and every mpv start (an mpv
// upgraded in place is probed again); a failed probe is retried. Windows never gates options by
// version, so it probes each time as before.
const versions = new Map<string, Promise<string | null>>();

export function mpvVersion(exe: string): Promise<string | null> {
  let key = '';
  if (process.platform !== 'win32') {
    try {
      key = `${exe}\0${fs.statSync(exe).mtimeMs}`;
    } catch {
      // Not stat-able: probe without caching.
    }
  }
  const known = key ? versions.get(key) : undefined;
  if (known) return known;
  const probe = new Promise<string | null>((resolve) => {
    execFile(exe, ['--no-config', '--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /mpv\s+(\S+)/.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
  if (key) {
    versions.set(key, probe);
    void probe.then((v) => v ?? versions.delete(key));
  }
  return probe;
}

// The JSON IPC endpoint: a named pipe on Windows; elsewhere a unix socket in $XDG_RUNTIME_DIR when it
// is a private directory (0700, ours), else in a fresh 0700 directory under the temp folder.
export function mpvIpcPath(id: string, platform: string = process.platform): { path: string; dir?: string } {
  if (platform === 'win32') return { path: `\\\\.\\pipe\\wicaby-mpv-${id}` };
  const run = process.env.XDG_RUNTIME_DIR;
  if (run?.startsWith('/') && isPrivateDir(run)) return { path: path.posix.join(run, `wicaby-mpv-${id}.sock`) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-mpv-'));
  return { path: path.posix.join(dir, `wicaby-mpv-${id}.sock`), dir };
}

function isPrivateDir(dir: string): boolean {
  try {
    const st = fs.statSync(dir);
    return st.isDirectory() && (st.mode & 0o077) === 0 && st.uid === process.getuid?.();
  } catch {
    return false;
  }
}

// What MpvPlayer drives: this child process over JSON IPC, or libmpv in-process (libmpv-controller.ts, native
// Wayland). Events: 'property'(name, data), 'event'(name, JSON IPC message), 'exit'(code), 'hung', 'ao-failed',
// 'vo-failed'.
export interface MpvTransport extends EventEmitter {
  start(args: string[]): Promise<void>;
  command(...args: unknown[]): Promise<unknown>;
  set(name: string, value: unknown): Promise<unknown>;
  get<T = unknown>(name: string): Promise<T>;
  observe(name: string): Promise<void>;
  quit(): Promise<void>;
}

// Drives an mpv.exe child process over its JSON IPC named pipe (a unix socket on Linux). Emby linked
// libmpv in-process through 26 P/Invokes; a child process keeps a decoder
// crash from taking the whole app down and lets users drop in any mpv build.
export class MpvController extends EventEmitter implements MpvTransport {
  private proc: ChildProcess | null = null;
  private pipe: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private observers = new Map<number, string>();
  private exited = false;

  constructor(private readonly exe: string) {
    super();
  }

  async start(args: string[]): Promise<void> {
    const ipc = mpvIpcPath(randomUUID());
    const pipeName = ipc.path;
    // Checks only (WICABY_TEST_SILENT=1, dropped by index.ts in a packaged build): no audio device is ever opened.
    const full = [...args, ...(process.env.WICABY_TEST_SILENT === '1' ? ['--ao=null'] : []), `--input-ipc-server=${pipeName}`];
    log.info(`spawning ${this.exe}`);
    // Windows: mpv's default per-wait 1 ms timer requests (hundreds per second) froze the whole player ~200 ms at a time
    // (dropped frames, audio underruns); one request for the process lifetime does not. Ignored elsewhere.
    const env = { ...process.env, MPV_HRT: process.env.MPV_HRT ?? 'always' };
    this.proc = spawn(this.exe, full, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    this.proc.stdout?.on('data', (d: Buffer) => this.logLines(d));
    this.proc.stderr?.on('data', (d: Buffer) => this.logLines(d));
    // Unix: the socket file (mpv removes it too) and our private temp folder, if one was made.
    const cleanup = () => process.platform !== 'win32' && fs.rm(ipc.dir ?? pipeName, { recursive: true, force: true }, () => undefined);
    this.proc.on('exit', (code) => {
      this.exited = true;
      cleanup();
      void this.watchdog?.terminate();
      log.info(`exited with code ${code}`);
      for (const p of this.pending.values()) p.reject(new Error('mpv exited'));
      this.pending.clear();
      this.emit('exit', code);
    });
    this.proc.on('error', (err) => {
      this.exited = true;
      // A failed spawn fires only 'error', never 'exit'.
      cleanup();
      log.error('spawn failed', err);
      this.emit('exit', null);
    });
    await this.connect(pipeName);
    this.startWatchdog(pipeName);
  }

  private watchdog: Worker | null = null;

  private startWatchdog(pipe: string): void {
    const pid = this.proc?.pid;
    if (!pid) return;
    const worker = new Worker(WATCHDOG, { eval: true, workerData: { pipe, pid, ping: PING_MS, hung: HUNG_MS, signal: KILL_SIGNAL } });
    worker.on('message', () => {
      log.warn(`no IPC answer for ${HUNG_MS / 1000} s, mpv killed`);
      this.proc?.kill(KILL_SIGNAL);
      this.emit('hung');
    });
    worker.on('error', (err) => log.warn('watchdog failed', err));
    worker.unref();
    this.watchdog = worker;
  }

  private logLines(data: Buffer): void {
    for (const line of data.toString('utf8').split(/\r?\n/)) {
      const c = classifyMpvLog(line);
      if (c.log) log.debug(line.trim());
      if (c.signal) this.emit(c.signal);
    }
  }

  private async connect(pipeName: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(t('errors.playback.mpvStartExit'));
      try {
        this.pipe = await new Promise<net.Socket>((resolve, reject) => {
          const sock = net.connect(pipeName);
          sock.once('connect', () => resolve(sock));
          sock.once('error', reject);
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!this.pipe) throw new Error(t('errors.playback.mpvPipe'));
    this.pipe.setEncoding('utf8');
    this.pipe.on('data', (chunk: string) => this.onData(chunk));
    this.pipe.on('error', (err) => log.warn('pipe error', err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.request_id === 'number' && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error === 'success') p.resolve(msg.data);
        else p.reject(new Error(String(msg.error)));
      } else if (msg.event === 'property-change') {
        this.emit('property', msg.name as string, msg.data);
      } else if (typeof msg.event === 'string') {
        this.emit('event', msg.event, msg);
      }
    }
  }

  command(...args: unknown[]): Promise<unknown> {
    if (!this.pipe || this.exited) return Promise.reject(new Error(t('errors.playback.mpvNotStarted')));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.pipe!.write(JSON.stringify({ command: args, request_id: id }) + '\n');
    });
  }

  set(name: string, value: unknown): Promise<unknown> {
    return this.command('set_property', name, value);
  }

  get<T = unknown>(name: string): Promise<T> {
    return this.command('get_property', name) as Promise<T>;
  }

  async observe(name: string): Promise<void> {
    const id = this.nextId++;
    this.observers.set(id, name);
    await this.command('observe_property', id, name);
  }

  async quit(): Promise<void> {
    if (!this.proc || this.exited) return;
    const proc = this.proc;
    // A slow but deliberate quit is not a hang.
    void this.watchdog?.terminate();
    await Promise.race([this.command('quit').catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => setTimeout(r, 300));
    if (!this.exited) proc.kill();
    this.pipe?.destroy();
    this.pipe = null;
  }
}
