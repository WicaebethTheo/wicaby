import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { parseMpvArgs } from '../../shared/mpv-args';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { LibmpvNative, NativeEvent, NativePlayer } from './libmpv-native';
import { classifyMpvLog, HUNG_MS, PING_MS, type MpvTransport } from './mpv-controller';

const log = logger.scope('libmpv');

// Generous: a deliberate quit that takes longer than this is treated as done, the handle abandoned.
const QUIT_MS = 1500;
const DESTROY_MS = 3000;

// Options that only mean something for mpv's own process or window: the render context replaces --wid and the
// GPU context, logs come through mpv_request_log_messages, the JSON IPC is not used. vo is forced below.
// force-window: there is no window to keep, and at mpv_initialize the render context does not exist yet, so mpv
// would only log a failed VO open. config is forced to no below.
const DROPPED = new Set(['wid', 'input-ipc-server', 'gpu-context', 'gpu-api', 'terminal', 'vo', 'force-window', 'config']);

// A list option with an action suffix (--glsl-shaders-append=x): the mpv CLI takes it, mpv_set_option_string only
// knows the bare name, so it becomes a change-list command once mpv runs.
const LIST_OP_RE = /^(.+)-(append|add|pre|set|remove|del|toggle|clr)$/;

// A user mpv.conf in texture mode. libmpv would load it inside mpv_initialize, after (and over) every option set
// here, and unlike the CLI nothing protects the command line from it: vo=gpu-next in it would open mpv's own window
// from Electron's main process, load-scripts=yes would run user scripts there, input-ipc-server would open a control
// socket. So config stays no, and the file goes through the same allow-list as "Arguments mpv supplémentaires"
// (shared/mpv-args.ts), at the place of Wicaby's --include: after Wicaby's defaults, before the fixed options.
// [profile] sections are skipped (profile= is refused anyway); [default] goes on with the top level.
export function mpvConfArgs(text: string): { args: string[]; rejected: string[]; profiles: string[] } {
  const args: string[] = [];
  const rejected: string[] = [];
  const profiles: string[] = [];
  let inProfile = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = /^\[([^\]]*)\]\s*(#.*)?$/.exec(line);
    if (section) {
      inProfile = section[1].trim() !== 'default';
      if (inProfile) profiles.push(section[1].trim());
      continue;
    }
    if (inProfile) continue;
    if (line.startsWith('--')) line = line.slice(2);
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:=\s*(.*))?$/.exec(line);
    const value = m?.[2] === undefined ? undefined : confValue(m[2]);
    // A value with a double quote cannot be passed through the argument tokenizer intact.
    if (!m || value === null || value?.includes('"')) {
      rejected.push(line);
      continue;
    }
    const parsed = parseMpvArgs(value === undefined ? `--${m[1]}` : `--${m[1]}="${value}"`);
    args.push(...parsed.args);
    rejected.push(...parsed.rejected.map(() => line));
  }
  return { args, rejected, profiles };
}

// An mpv.conf value: "quoted", 'quoted', %n%fixed-length, or bare up to a # comment. null: unparsable.
function confValue(v: string): string | null {
  const q = /^(["'])(.*?)\1\s*(#.*)?$/.exec(v);
  if (q) return q[2];
  if (v.startsWith('"') || v.startsWith("'")) return null;
  const fixed = /^%(\d+)%/.exec(v);
  if (fixed) {
    const body = v.slice(fixed[0].length);
    const n = Number(fixed[1]);
    return n <= body.length && /^\s*(#.*)?$/.test(body.slice(n)) ? body.slice(0, n) : null;
  }
  return v.replace(/(^|\s)#.*$/, '').trim();
}

// ao=pipewire in this process gets Wicaby killed (SIGKILL, no core dump) a few seconds into playback: libpipewire
// has its stream thread made realtime through rtkit, which puts an RLIMIT_RTTIME on Electron's whole main process.
// The mpv process never hits it. pulse reaches the same PipeWire server through pipewire-pulse, so texture mode
// leaves pipewire out of the ao list and maps a pipewire/<node> audio device to pulse/<node> (same sink name).
export function inProcessAo(value: string): string {
  const aos = value.split(',').map((x) => x.trim()).filter((x) => x && x !== 'pipewire');
  return aos.length ? aos.join(',') : 'pulse,alsa';
}
export function inProcessAudioDevice(value: string): string {
  return value.startsWith('pipewire/') ? `pulse/${value.slice('pipewire/'.length)}` : value;
}

export interface LibmpvPlan {
  // Before mpv_initialize, in order.
  options: [string, string][];
  // After it, in order: change-list <name> <op> <value>.
  listOps: [string, string, string][];
}

// mpv's command line as option/value pairs: --k=v (split at the first '='), --no-k (k=no), --k (k=yes); a user
// mpv.conf (--include) expanded in place, list actions after mpv_initialize. A later plain set of a list drops the
// actions before it, as on the CLI.
export function libmpvPlan(
  args: string[],
  silent = process.env.WICABY_TEST_SILENT === '1',
  readConf: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): LibmpvPlan {
  const options: [string, string][] = [];
  let listOps: [string, string, string][] = [];
  const add = (arg: string) => {
    if (!arg.startsWith('--') || arg.length < 3) return;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    let [name, value] = eq >= 0 ? [body.slice(0, eq), body.slice(eq + 1)] : [body, 'yes'];
    if (eq < 0 && name.startsWith('no-')) [name, value] = [name.slice(3), 'no'];
    if (DROPPED.has(name)) return;
    if (name === 'include') {
      let text: string;
      try {
        text = readConf(value);
      } catch (err) {
        log.warn(`mpv.conf not read: ${value}`, err);
        return;
      }
      const conf = mpvConfArgs(text);
      if (conf.rejected.length) log.warn(`mpv.conf lines ignored in texture mode (allow-listed options only): ${conf.rejected.join(' | ')}`);
      if (conf.profiles.length) log.warn(`mpv.conf profiles ignored in texture mode: ${conf.profiles.join(', ')}`);
      conf.args.forEach(add);
      return;
    }
    const list = LIST_OP_RE.exec(name);
    if (list) {
      listOps.push([list[1], list[2], eq >= 0 ? value : '']);
      return;
    }
    listOps = listOps.filter(([base]) => base !== name);
    if (name === 'ao') value = inProcessAo(value);
    else if (name === 'audio-device') value = inProcessAudioDevice(value);
    options.push([name, value]);
  };
  args.forEach(add);
  // video-timing-offset=0: the render thread draws as soon as mpv has a frame (BLOCK_FOR_TARGET_TIME=0), so mpv must
  // signal each frame at its display time itself, or video runs up to 50 ms ahead of the audio (render.h).
  options.push(['vo', 'libmpv'], ['terminal', 'no'], ['config', 'no'], ['video-timing-offset', '0']);
  // Checks only (WICABY_TEST_SILENT=1, as MpvController): no audio device is ever opened.
  if (silent) options.push(['ao', 'null']);
  return { options, listOps };
}

// The options part of libmpvPlan.
export function libmpvOptions(args: string[], silent = process.env.WICABY_TEST_SILENT === '1', readConf?: (file: string) => string): [string, string][] {
  return libmpvPlan(args, silent, readConf).options;
}

// MpvController's surface and events over libmpv in this process (native Wayland, texture mode), so MpvPlayer
// runs unchanged. Also re-emits the addon's 'buffers' and 'frame' events for VideoSurface, and emits 'render-error'
// (message) just before 'exit' when the render thread failed (the service then goes on in detached mode), and
// 'render-warning' (text) for the addon's non-fatal ones (a failed ring resize; VideoSurface retries). Unlike
// the child process, a hung or crashed core cannot be killed: 'hung' is the only recovery (the service falls back
// to html), and WICABY_MPV_RENDER=detached is the escape hatch from a crashing libmpv.
export class LibmpvController extends EventEmitter implements MpvTransport {
  readonly native: NativePlayer;
  // The latest ring: the first one may land before VideoSurface subscribes.
  lastBuffers: Extract<NativeEvent, { type: 'buffers' }> | null = null;
  // Options this libmpv may not know (mpv-player.ts: gated by version on the CLI): skipped when refused instead of
  // failing the start. mpv-version cannot be read before mpv_initialize.
  optional: ReadonlySet<string> = new Set();
  private started = false;
  private exited = false;
  private hung = false;
  private pingTimer: NodeJS.Timeout | null = null;
  // Rejecters of the calls in flight: a hung or gone core never answers them, and MpvController rejects its own
  // pending calls when mpv exits.
  private pending = new Set<(err: Error) => void>();

  constructor(
    lib: LibmpvNative,
    // Physical pixels of the first ring; VideoSurface sets the window's size through resize().
    private size: { width: number; height: number } = { width: 1280, height: 720 },
    renderNode?: string,
  ) {
    super();
    this.native = lib.create((e) => this.onNative(e), renderNode);
  }

  async start(args: string[]): Promise<void> {
    const plan = libmpvPlan(args);
    for (const [name, value] of plan.options) {
      try {
        this.native.setOption(name, value);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (this.optional.has(name)) {
          log.info(`option ${name}=${value} not supported by this libmpv, skipped (${reason})`);
          continue;
        }
        // As mpv refusing its command line: nothing starts.
        throw new Error(`mpv option ${name}=${value}: ${reason}`);
      }
    }
    log.info('starting libmpv');
    this.native.initialize(Math.max(1, Math.round(this.size.width)), Math.max(1, Math.round(this.size.height)));
    this.started = true;
    this.startPing();
    for (const [name, op, value] of plan.listOps) {
      // Not fatal: the rest of the command line is in place, and the CLI would only have refused a bad value.
      await this.command('change-list', name, op, value).catch((err) => log.warn(`mpv option ${name}-${op}=${value} refused`, err));
    }
  }

  // The ring's size in physical pixels. Before start() it only sets the first ring: the addon refuses a resize
  // until initialize(), and VideoSurface sizes the ring as soon as it exists, before mpv is started.
  resize(width: number, height: number): void {
    if (this.exited) return;
    if (!this.started) this.size = { width, height };
    else this.native.resize(width, height);
  }

  private onNative(e: NativeEvent): void {
    switch (e.type) {
      case 'property':
        this.emit('property', e.name, e.data);
        break;
      case 'event':
        this.emit('event', e.name, e.msg);
        break;
      case 'log':
        // The addon's own non-fatal warnings (a ring resize that failed: the old ring stays in use).
        if (e.prefix === 'wicaby-render') {
          log.warn(`render thread: ${e.text}`);
          this.emit('render-warning', e.text);
          // Allocation path, modifier and GPU sync of each ring: what a black-picture report needs.
        } else if (e.prefix === 'wicaby-render-info') log.info(`render thread: ${e.text}`);
        else this.logLine(e.prefix, e.text);
        break;
      case 'buffers':
        this.lastBuffers = e;
        this.emit('buffers', e);
        break;
      case 'frame':
        this.emit('frame', e);
        break;
      case 'shutdown':
        this.markExited(0);
        break;
      case 'error':
        // No picture can come out any more: 'render-error' first, so MpvPlayer can tell this from mpv exiting and
        // the service can carry on in mpv's own window (playback-service.ts).
        log.error(`render thread failed: ${e.message}`);
        if (!this.exited) this.emit('render-error', e.message);
        void this.native.destroy().catch(() => undefined);
        this.markExited(null);
        break;
    }
  }

  // Same lines MpvController reads on mpv's stderr.
  private logLine(prefix: string, text: string): void {
    const line = text.trim();
    const c = classifyMpvLog(line);
    if (c.log) log.debug(`[${prefix}] ${line}`);
    if (c.signal) this.emit(c.signal);
  }

  private markExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stopPing();
    this.rejectPending();
    log.info(`libmpv stopped (${code ?? 'error'})`);
    this.emit('exit', code);
  }

  // A native call that settles at the latest when the core is declared hung or gone.
  private track<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      p.then(
        (v) => {
          this.pending.delete(reject);
          resolve(v);
        },
        (err: unknown) => {
          this.pending.delete(reject);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private rejectPending(): void {
    const err = new Error(t('errors.playback.mpvExited'));
    const pending = [...this.pending];
    this.pending.clear();
    for (const reject of pending) reject(err);
  }

  private notRunning(): Error | null {
    if (this.hung) return new Error(t('errors.playback.mpvExited'));
    return !this.started || this.exited ? new Error(t('errors.playback.mpvNotStarted')) : null;
  }

  // A getProperty every 5 s through the core's own queue; 10 s without an answer is a hang. The core lives in
  // this process, so there is nothing to kill: only 'hung' is emitted.
  private startPing(): void {
    let last = Date.now();
    let tick = last;
    let waiting = false;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      // A late tick means the machine slept or this thread stalled: restart the clock.
      if (now - tick > PING_MS * 3) last = now;
      tick = now;
      if (now - last > HUNG_MS) {
        this.stopPing();
        this.hung = true;
        log.warn(`no answer from libmpv for ${HUNG_MS / 1000} s`);
        // Nothing will answer them: MpvPlayer.create, if still starting, fails instead of waiting forever.
        this.rejectPending();
        this.emit('hung');
        return;
      }
      if (waiting) return;
      waiting = true;
      const answered = () => {
        waiting = false;
        last = Date.now();
      };
      this.native.getProperty('pid').then(answered, answered);
    }, PING_MS);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  command(...args: unknown[]): Promise<unknown> {
    const err = this.notRunning();
    return err ? Promise.reject(err) : this.track(this.native.command(args));
  }

  set(name: string, value: unknown): Promise<unknown> {
    const err = this.notRunning();
    if (name === 'audio-device' && typeof value === 'string') value = inProcessAudioDevice(value);
    return err ? Promise.reject(err) : this.track(this.native.setProperty(name, value));
  }

  get<T = unknown>(name: string): Promise<T> {
    const err = this.notRunning();
    return err ? Promise.reject(err) : (this.track(this.native.getProperty(name)) as Promise<T>);
  }

  async observe(name: string): Promise<void> {
    const err = this.notRunning();
    if (err) throw err;
    this.native.observe(name);
  }

  async quit(): Promise<void> {
    this.stopPing();
    const within = async (p: Promise<unknown>, ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    };
    if (this.started && !this.exited) await within(this.native.command(['quit']).catch(() => undefined), QUIT_MS);
    // A hung core may never finish: the handle is abandoned rather than block playback teardown.
    await within(this.native.destroy().catch((err) => log.warn('libmpv destroy failed', err)), DESTROY_MS);
    this.lastBuffers = null;
    this.markExited(0);
  }
}
