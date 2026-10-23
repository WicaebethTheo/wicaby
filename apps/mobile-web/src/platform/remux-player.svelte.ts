// The phone's video player. Files Safari opens itself (MP4, MOV, the server's HLS) play in the <video> element as
// on webOS (HtmlPlayer). A Matroska file (MKV, WebM) is remuxed on the phone instead of converted on the server:
// read with Range requests (the server only reads its disk), demuxed, rewritten as fragmented MP4 without decoding
// anything (media/), and fed to Safari's ManagedMediaSource, whose hardware decoders play HEVC, Dolby Vision,
// AV1, Dolby Digital (Plus) and the rest. Text subtitles are read from the file too.
//
// Times. The remuxed timeline runs LEAD_MS ahead of the file's (media/remux.ts): positions and seeks are shifted
// here, so the session sees the file's times. The engine (media/engine.ts) loads with the first Matroska file.
import { HtmlPlayer } from '$tvplatform/html-player';
import type { Track as PlayerTrack } from '$tvplatform/player';
import type { Cue } from '$tv/subtitles';
import type { Frame, Header, Track } from '../media/matroska';
import type { Output, Remuxer } from '../media/remux';
import type { ByteSource } from '../media/source';
import type { PgsDecoder, PgsPicture } from '../media/pgs';
import { localMedia } from '../lib/downloads.svelte';

type Engine = typeof import('../media/engine');
let engine: Promise<Engine> | null = null;
const loadEngine = () => (engine ??= import('../media/engine'));

type MMS = MediaSource & { streaming?: boolean };

const MediaSourceClass: (new () => MMS) | undefined =
  (window as unknown as { ManagedMediaSource?: new () => MMS }).ManagedMediaSource ?? (window as unknown as { MediaSource?: new () => MMS }).MediaSource;

export const remuxAvailable = (): boolean => !!MediaSourceClass;

export function remuxSupports(mime: string): boolean {
  const C = MediaSourceClass as unknown as { isTypeSupported?(t: string): boolean } | undefined;
  try {
    return !!C?.isTypeSupported?.(mime);
  } catch {
    return false;
  }
}

const isMatroska = (b: Uint8Array) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
const BEHIND_S = 30;
// Above WebKit's own startstreaming level (10 s), for headroom on a 4K remux.
const STREAMING_FLOOR_S = 15;
const PGS = 'S_HDMV/PGS';
// A picture shows until the next display set clears or replaces it; this long if none comes (a cut file).
const PGS_OPEN_MS = 60_000;

// A cue the app draws: text, or a PGS picture (components/player/Subtitles.svelte). open: its end not known yet.
export type ImageCue = Cue & { pgs?: PgsPicture; open?: boolean };

export class RemuxPlayer extends HtmlPlayer {
  // Reactive: the player screen shows how the title plays.
  private remuxing = $state(false);
  private source: ByteSource | null = null;
  private header: Header | null = null;
  private ms: MMS | null = null;
  private buffers: { video?: SourceBuffer; audio?: SourceBuffer } = {};
  private remux: Remuxer | null = null;
  private generation = 0;
  private audioTracksList: Track[] = [];
  private textTrackList: Track[] = [];
  private cues = new Map<number, ImageCue[]>();
  private cueListeners = new Map<number, (cues: Cue[]) => void>();
  // Image subtitles: a decoder per track for the current read (a seek starts a new epoch), the frames handled in
  // order after any inflating.
  private pgs = new Map<number, PgsDecoder>();
  private pgsGeneration = -1;
  private subtitleQueue: Promise<void> = Promise.resolve();
  private aheadS = 60;
  private wake: (() => void) | null = null;
  private objectUrl: string | null = null;
  private E: Engine | null = null;
  private lead = 0;

  constructor(private readonly el: HTMLVideoElement) {
    super(el);
    el.addEventListener('timeupdate', () => this.wake?.());
  }

  override async open(url: string, startMs = 0): Promise<void> {
    this.teardown();
    // A downloaded title plays from the phone, online or not (lib/downloads).
    const local = await localMedia(url);
    if (local) {
      const head = new Uint8Array(await local.slice(0, 64).arrayBuffer());
      if (!isMatroska(head) || !remuxAvailable()) {
        this.objectUrl = URL.createObjectURL(local);
        return super.open(this.objectUrl, startMs);
      }
      const E = (this.E = await loadEngine());
      return this.openRemux(new E.BlobSource(local), startMs);
    }
    // The server's HLS and plain files: Safari's own pipeline.
    if (/\.m3u8(\?|$)/i.test(url) || !remuxAvailable()) return super.open(url, startMs);
    const progressive = !/[?&]static=true/i.test(url);
    const E = (this.E = await loadEngine());
    let source: ByteSource;
    if (progressive) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const first = await reader.read();
      const head = first.value ?? new Uint8Array(0);
      if (!isMatroska(head)) {
        void reader.cancel();
        return super.open(url, startMs);
      }
      // The bytes already read go first.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(head);
        },
        async pull(c) {
          const r = await reader.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
        },
        cancel() {
          void reader.cancel();
        },
      });
      source = new E.StreamSource(new Response(body));
    } else {
      const probe = await E.RangeSource.probe(url);
      if (!isMatroska(probe.head)) return super.open(url, startMs);
      source = probe.source;
    }
    await this.openRemux(source, startMs);
  }

  private async openRemux(source: ByteSource, startMs: number): Promise<void> {
    const E = this.E!;
    const header = await E.readHeader(source);
    this.lead = E.LEAD_MS;
    this.source = source;
    this.header = header;
    this.remuxing = true;
    this.audioTracksList = header.tracks.filter((t) => t.kind === 'audio');
    this.textTrackList = header.tracks.filter((t) => t.kind === 'subtitle' && (/^S_TEXT\//.test(t.codec) || t.codec === PGS));
    const video = header.tracks.find((t) => t.kind === 'video');
    // The default audio track when the device decodes it, else the first one it does; none at all: the server
    // converts (the session falls back on this error).
    const playable = this.audioTracksList.filter((t) => {
      const mime = E.familyMime(t);
      return !!mime && remuxSupports(mime);
    });
    if (this.audioTracksList.length && !playable.length) throw new Error('no audio track this device decodes');
    const audio = playable.find((t) => t.isDefault) ?? playable[0];
    this.remux = new E.Remuxer(video, audio);
    // Bytes per second of the file: hold about 200 MB ahead at most, between 15 s and 90 s.
    const rate = source.size && header.durationMs ? source.size / (header.durationMs / 1000) : 2_000_000;
    this.aheadS = Math.max(15, Math.min(90, 200_000_000 / rate));

    const ms = new MediaSourceClass!();
    this.ms = ms;
    // ManagedMediaSource plays only without remote playback (AirPlay takes the server's HLS instead).
    this.el.disableRemotePlayback = true;
    const opened = new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
    // Safari takes a ManagedMediaSource as srcObject (what it asks for); an engine that refuses it gets a URL.
    try {
      (this.el as HTMLVideoElement & { srcObject: unknown }).srcObject = ms;
    } catch {
      this.el.src = this.objectUrl = URL.createObjectURL(ms);
    }
    ms.addEventListener('startstreaming', () => this.wake?.());
    await opened;
    if (header.durationMs) ms.duration = (header.durationMs + this.lead) / 1000;
    const loaded = new Promise<void>((resolve, reject) => {
      const done = () => (cleanup(), resolve());
      const fail = () => (cleanup(), reject(new Error(this.el.error?.message || 'media error')));
      const cleanup = () => {
        this.el.removeEventListener('loadedmetadata', done);
        this.el.removeEventListener('error', fail);
      };
      this.el.addEventListener('loadedmetadata', done);
      this.el.addEventListener('error', fail);
    });
    this.pumpFrom(startMs);
    await loaded;
    this.el.currentTime = (startMs + this.lead) / 1000;
  }

  // ---- Feeding ----

  private pumpFrom(ms: number): void {
    const gen = ++this.generation;
    const h = this.header!;
    // A stream is read from its start (the server begins it at the asked time); a file from the cue before [ms].
    const offset = this.source!.seekable ? (this.E!.cueBefore(h.cues, ms)?.offset ?? h.firstCluster) : 0;
    this.remux!.reset();
    void this.pump(gen, offset).catch((e) => {
      if (gen !== this.generation) return;
      console.warn('remux:', e);
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit('error', e instanceof Error ? e.message : String(e));
    });
  }

  private async pump(gen: number, offset: number): Promise<void> {
    const rx = this.remux!;
    for await (const frames of this.E!.clusters(this.source!, this.header!, offset)) {
      if (gen !== this.generation) return;
      this.takeSubtitles(frames, gen);
      for (const out of rx.push(frames)) await this.append(out, gen);
      if (gen !== this.generation) return;
      await this.waitForRoom(gen);
      if (gen !== this.generation) return;
    }
    for (const out of rx.flush()) await this.append(out, gen);
    if (gen === this.generation && this.ms?.readyState === 'open') {
      await this.idle();
      try {
        this.ms.endOfStream();
      } catch {
        // Already ended or closed.
      }
    }
  }

  // Waits while enough is buffered ahead, or while ManagedMediaSource asks to stop streaming.
  private async waitForRoom(gen: number): Promise<void> {
    for (;;) {
      if (gen !== this.generation) return;
      const ahead = this.bufferedAhead();
      // ManagedMediaSource asks for data (startstreaming) only below about 10 s buffered, and only once it has some:
      // under STREAMING_FLOOR_S, feed regardless; above it, follow its endstreaming as well as the cap.
      const paused = this.ms?.streaming === false && ahead >= STREAMING_FLOOR_S;
      if (ahead < this.aheadS && !paused) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
        setTimeout(() => this.wake?.(), 2000);
      });
    }
  }

  private bufferedAhead(): number {
    const v = this.buffers.video ?? this.buffers.audio;
    if (!v) return 0;
    const t = this.el.currentTime;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
    return 0;
  }

  // Every SourceBuffer is added before the first append (MediaSource refuses one more once data came in).
  private sourceBuffer(kind: 'video' | 'audio'): SourceBuffer | undefined {
    const rx = this.remux!;
    if (!this.ms) return undefined;
    if (!this.buffers.video && !this.buffers.audio) {
      if (rx.video) this.buffers.video = this.ms.addSourceBuffer(rx.video.mime);
      if (rx.audio) this.buffers.audio = this.ms.addSourceBuffer(rx.audio.mime);
    }
    return this.buffers[kind];
  }

  private async append(out: Output, gen: number): Promise<void> {
    const r = out.kind === 'video' ? this.remux!.video : this.remux!.audio;
    const sb = this.sourceBuffer(out.kind) as (SourceBuffer & { init?: Uint8Array }) | undefined;
    if (!sb || !r) return;
    // A new remuxer (another audio track): its codec and its init segment first.
    if (sb.init !== r.init) {
      await this.whenIdle(sb);
      if (sb.init && 'changeType' in sb) sb.changeType(r.mime);
      await this.push(sb, r.init, gen);
      sb.init = r.init;
    }
    await this.push(sb, out.data, gen);
  }

  private async push(sb: SourceBuffer, data: Uint8Array, gen: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (gen !== this.generation) return;
      await this.whenIdle(sb);
      try {
        sb.appendBuffer(data as BufferSource);
        await this.whenIdle(sb);
        return;
      } catch (e) {
        // Full: drop what was played more than BEHIND_S ago, then retry.
        if ((e as DOMException).name !== 'QuotaExceededError') throw e;
        await this.trim(BEHIND_S / (attempt + 1));
      }
    }
  }

  private whenIdle(sb: SourceBuffer): Promise<void> {
    return sb.updating ? new Promise((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true })) : Promise.resolve();
  }

  private async idle(): Promise<void> {
    for (const sb of Object.values(this.buffers)) if (sb) await this.whenIdle(sb);
  }

  private async trim(behind: number): Promise<void> {
    const end = this.el.currentTime - behind;
    if (end <= 0) return;
    for (const sb of Object.values(this.buffers)) {
      if (!sb) continue;
      await this.whenIdle(sb);
      sb.remove(0, end);
      await this.whenIdle(sb);
    }
  }

  // ---- Subtitles read from the file ----

  private takeSubtitles(frames: Frame[], gen: number): void {
    const mine = frames.filter((f) => this.textTrackList.some((t) => t.number === f.track));
    if (!mine.length) return;
    // Plain text, the common case, at once; anything to inflate or decode in order behind what is queued.
    if (mine.every((f) => this.isPlainText(f.track))) return mine.forEach((f) => this.takeText(f, f.data));
    this.subtitleQueue = this.subtitleQueue.then(async () => {
      for (const f of mine) {
        if (gen !== this.generation) return;
        const t = this.textTrackList.find((x) => x.number === f.track)!;
        const data = t.zlib ? await this.E!.inflate(f.data).catch(() => null) : f.data;
        if (!data || gen !== this.generation) continue;
        if (t.codec === PGS) this.takePgs(t, data, f.ptsMs, gen);
        else this.takeText(f, data);
      }
    });
  }

  private isPlainText(track: number): boolean {
    const t = this.textTrackList.find((x) => x.number === track);
    return !!t && !t.zlib && t.codec !== PGS;
  }

  private takeText(f: Frame, data: Uint8Array): void {
    const t = this.textTrackList.find((x) => x.number === f.track)!;
    const cue = this.E!.subtitleCue(t, { ...f, data });
    if (cue) this.addCue(t.number, cue);
  }

  // A display set ends the picture before it (if still showing) and may show a new one, until the next set.
  private takePgs(t: Track, data: Uint8Array, ms: number, gen: number): void {
    if (this.pgsGeneration !== gen) {
      this.pgs.clear();
      this.pgsGeneration = gen;
    }
    let decoder = this.pgs.get(t.number);
    if (!decoder) this.pgs.set(t.number, (decoder = new this.E!.PgsDecoder()));
    const event = decoder.push(data, ms);
    if (!event) return;
    const list = this.cues.get(t.number) ?? [];
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.open && c.startMs < event.ms && c.endMs > event.ms) {
        list[i] = { ...c, endMs: event.ms, open: false };
        changed = true;
      }
    }
    this.cues.set(t.number, list);
    if (event.picture) this.addCue(t.number, { startMs: event.ms, endMs: event.ms + PGS_OPEN_MS, html: '', pgs: event.picture, open: true });
    else if (changed) this.cueListeners.get(t.number)?.([...list]);
  }

  private addCue(track: number, cue: ImageCue): void {
    const list = this.cues.get(track) ?? [];
    // Kept sorted and without duplicates (a seek reads clusters again).
    if (list.some((c) => c.startMs === cue.startMs && c.html === cue.html)) return void this.cueListeners.get(track)?.([...list]);
    let i = list.length;
    while (i > 0 && list[i - 1].startMs > cue.startMs) i--;
    list.splice(i, 0, cue);
    this.cues.set(track, list);
    this.cueListeners.get(track)?.([...list]);
  }

  // The session's hook for a text or PGS subtitle inside the file (its position among the file's subtitle tracks): the
  // cues as they are read, so the server never extracts them. false: not a text track this player reads.
  drawsEmbedded(position: number): boolean {
    if (!this.remuxing || !this.header) return false;
    const t = this.header.tracks.filter((x) => x.kind === 'subtitle')[position];
    return !!t && this.textTrackList.includes(t);
  }

  embeddedCues(position: number, onChange: (cues: Cue[]) => void): boolean {
    if (!this.drawsEmbedded(position)) return false;
    const t = this.header!.tracks.filter((x) => x.kind === 'subtitle')[position];
    this.cueListeners.clear();
    this.cueListeners.set(t.number, onChange);
    onChange([...(this.cues.get(t.number) ?? [])]);
    return true;
  }

  // The file is remuxed on the phone (the Matroska path), rather than played by Safari as served.
  get remuxed(): boolean {
    return this.remuxing;
  }

  private lastError = '';

  // What the "Playback info" sheet shows: the source, the codecs fed to Safari, the buffer, the last error.
  diagnostics(): string[] {
    const rx = this.remux;
    const ahead = this.bufferedAhead();
    return [
      this.remuxing ? `Remux · ${this.source?.seekable ? 'Range' : 'stream'}${this.source?.size ? ` · ${(this.source.size / 1e9).toFixed(2)} GB` : ''}` : 'Safari',
      ...(rx?.video ? [rx.video.mime.replace(/^.*codecs="|"$/g, '')] : []),
      ...(rx?.audio ? [rx.audio.mime.replace(/^.*codecs="|"$/g, '')] : []),
      `${this.ms ? (this.ms.constructor as { name: string }).name : 'video'} · ${this.ms?.readyState ?? '-'} · streaming ${String(this.ms?.streaming ?? '-')}`,
      `buffer +${ahead.toFixed(1)} s · readyState ${this.el.readyState}${this.el.error ? ` · error ${this.el.error.code} ${this.el.error.message}` : ''}`,
      ...(this.lastError ? [this.lastError] : []),
    ];
  }

  // ---- The player interface, on the file's timeline ----

  override get positionMs(): number {
    return this.remuxing ? Math.max(0, this.el.currentTime * 1000 - this.lead) : super.positionMs;
  }

  override get durationMs(): number {
    if (!this.remuxing) return super.durationMs;
    return this.header?.durationMs ?? Math.max(0, super.durationMs - this.lead);
  }

  override seek(ms: number): void {
    if (!this.remuxing) return super.seek(ms);
    const target = Math.max(0, ms);
    const t = (target + this.lead) / 1000;
    const sb = this.buffers.video ?? this.buffers.audio;
    let inside = false;
    if (sb) for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= t && sb.buffered.end(i) > t + 1) inside = true;
    // Outside what is buffered: read from the cue point before it.
    if (!inside && this.source?.seekable) this.pumpFrom(target);
    this.el.currentTime = t;
  }

  override audioTracks(): PlayerTrack[] {
    if (!this.remuxing) return super.audioTracks();
    return this.audioTracksList.map((t, index) => ({ index, language: t.language ?? '', label: t.name ?? '' }));
  }

  override selectAudio(index: number): void {
    if (!this.remuxing) return super.selectAudio(index);
    const t = this.audioTracksList[index];
    if (!t || t === this.remux?.audioTrack || !this.source?.seekable) return;
    this.remux!.switchAudio(t);
    const sb = this.buffers.audio;
    const at = this.positionMs;
    void (async () => {
      if (sb) {
        await this.whenIdle(sb);
        sb.remove(0, Infinity);
        await this.whenIdle(sb);
      }
      this.pumpFrom(at);
    })();
  }

  override stop(): void {
    this.teardown();
    super.stop();
  }

  private teardown(): void {
    this.generation++;
    this.wake?.();
    this.remuxing = false;
    this.header = null;
    this.source = null;
    this.remux = null;
    this.buffers = {};
    this.cues.clear();
    this.cueListeners.clear();
    this.pgs.clear();
    if (this.ms) {
      (this.el as HTMLVideoElement & { srcObject: unknown }).srcObject = null;
      this.ms = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.el.disableRemotePlayback = false;
  }
}
