// Matroska frames to fragmented MP4, one video and one audio track, copied as they are (no decoding).
//
// Timing. Matroska stores presentation times; MP4 needs decode times too. Within a GOP (keyframe to keyframe, the
// frames in decode order), the decode times are the GOP's presentation times sorted, which keeps them increasing
// across GOPs. Every presentation time is then shifted by LEAD so it never comes before its decode time (a B-frame
// pyramid reorders well under LEAD); audio and subtitles shift by the same LEAD, and the player hides it.
// Audio times run on from one frame to the next in samples (frame durations come from the bitstream), and follow
// the file's times again only after a real gap, so MP4's sample-exact audio has no drift and no clicks.
import { mapTrack, needsFirstFrame, type Mapped } from './codecs';
import type { Frame, Track } from './matroska';
import { fragment, initSegment, type Sample } from './mp4';

export const LEAD_MS = 500;

// Audio fragments flush at least this often (in ms of media) when no video frames flush them.
const AUDIO_FLUSH_MS = 1000;

export interface Output {
  kind: 'video' | 'audio';
  data: Uint8Array;
  // Presentation range covered, in file milliseconds.
  startMs: number;
  endMs: number;
}

export class TrackRemuxer {
  readonly mapped: Mapped;
  readonly init: Uint8Array;
  private gop: Frame[] = [];
  private audio: { frame: Frame; ts: number; samples: number }[] = [];
  private nextAudioTs: number | null = null;
  private lastVideoDur = 0;

  constructor(
    readonly track: Track,
    readonly kind: 'video' | 'audio',
    first: Uint8Array | undefined,
  ) {
    const m = mapTrack(track, first);
    if (!m) throw new Error(`unsupported codec ${track.codec}`);
    this.mapped = m;
    this.init = initSegment({ id: 1, kind, timescale: m.timescale, sampleEntry: m.entry, width: track.width, height: track.height, language: track.language });
    const ns = track.defaultDuration;
    this.lastVideoDur = ns ? Math.round((ns / 1e9) * m.timescale) : Math.round(m.timescale / 24);
  }

  get mime(): string {
    return this.mapped.mime;
  }

  // A seek: what is held belongs to the old position.
  reset(): void {
    this.gop = [];
    this.audio = [];
    this.nextAudioTs = null;
  }

  push(f: Frame): Output | null {
    return this.kind === 'video' ? this.pushVideo(f) : this.pushAudio(f);
  }

  // What is held, written out (end of the file, or before a seek).
  flush(): Output | null {
    return this.kind === 'video' ? this.flushGop(null) : this.flushAudio();
  }

  private ts(ms: number): number {
    return Math.round((ms / 1000) * this.mapped.timescale);
  }

  // ---- Video: a fragment per GOP ----

  private pushVideo(f: Frame): Output | null {
    if (f.key && this.gop.length) {
      const out = this.flushGop(f.ptsMs);
      this.gop = [f];
      return out;
    }
    // A GOP starts at a keyframe: frames before the first one (after a seek into a cluster) are dropped.
    if (!this.gop.length && !f.key) return null;
    this.gop.push(f);
    return null;
  }

  private flushGop(nextKeyPtsMs: number | null): Output | null {
    const gop = this.gop;
    this.gop = [];
    if (!gop.length) return null;
    const pts = gop.map((f) => this.ts(f.ptsMs));
    const dts = [...pts].sort((a, b) => a - b);
    const lead = this.ts(LEAD_MS);
    const end = nextKeyPtsMs !== null ? this.ts(nextKeyPtsMs) : null;
    const samples: Sample[] = gop.map((f, i) => {
      const next = i + 1 < gop.length ? dts[i + 1] : end;
      let duration = next !== null ? next - dts[i] : this.lastVideoDur;
      if (duration <= 0) duration = this.lastVideoDur;
      else this.lastVideoDur = duration;
      return { data: f.data, duration, cto: pts[i] + lead - dts[i], key: i === 0 };
    });
    const startMs = Math.min(...gop.map((f) => f.ptsMs));
    const endMs = Math.max(...gop.map((f) => f.ptsMs)) + (this.lastVideoDur / this.mapped.timescale) * 1000;
    return { kind: 'video', data: fragment(1, dts[0], samples), startMs, endMs };
  }

  // ---- Audio: continuous sample times, a fragment about every second ----

  private pushAudio(f: Frame): Output | null {
    const samples = this.mapped.frameSamples!(f.data);
    const fileTs = this.ts(f.ptsMs + LEAD_MS);
    // Follow the file again after a gap (or at the start): more than one frame away from the running time.
    if (this.nextAudioTs === null || Math.abs(fileTs - this.nextAudioTs) > samples) this.nextAudioTs = fileTs;
    const ts = this.nextAudioTs;
    this.nextAudioTs += samples;
    // A jump backwards or forwards starts a new fragment, so each fragment's samples are contiguous.
    const last = this.audio[this.audio.length - 1];
    let out: Output | null = null;
    if (last && last.ts + last.samples !== ts) out = this.flushAudio();
    this.audio.push({ frame: f, ts, samples });
    const span = ((this.audio[this.audio.length - 1].ts + samples - this.audio[0].ts) / this.mapped.timescale) * 1000;
    if (!out && span >= AUDIO_FLUSH_MS) out = this.flushAudio();
    return out;
  }

  private flushAudio(): Output | null {
    const list = this.audio;
    this.audio = [];
    if (!list.length) return null;
    const samples: Sample[] = list.map((a) => ({ data: a.frame.data, duration: a.samples, cto: 0, key: true }));
    const scale = this.mapped.timescale;
    const startMs = (list[0].ts / scale) * 1000 - LEAD_MS;
    const lastA = list[list.length - 1];
    return { kind: 'audio', data: fragment(1, list[0].ts, samples), startMs, endMs: ((lastA.ts + lastA.samples) / scale) * 1000 - LEAD_MS };
  }
}

// The video and audio remuxers of a playback, built once their first frames are known.
export class Remuxer {
  video: TrackRemuxer | null = null;
  audio: TrackRemuxer | null = null;
  private waiting: Frame[] = [];

  constructor(
    readonly videoTrack: Track | undefined,
    public audioTrack: Track | undefined,
  ) {}

  // Ready to give init segments: every chosen track has its remuxer.
  get ready(): boolean {
    return (!this.videoTrack || !!this.video) && (!this.audioTrack || !!this.audio);
  }

  private build(f: Frame): void {
    if (this.videoTrack && !this.video && f.track === this.videoTrack.number) this.video = new TrackRemuxer(this.videoTrack, 'video', undefined);
    if (this.audioTrack && !this.audio && f.track === this.audioTrack.number)
      this.audio = new TrackRemuxer(this.audioTrack, 'audio', needsFirstFrame(this.audioTrack) ? f.data : undefined);
  }

  // Frames in, fragments out. Until both remuxers exist, frames wait (an AC-3 track's first frame comes after the
  // first video frames).
  push(frames: Frame[]): Output[] {
    const out: Output[] = [];
    for (const f of frames) {
      if (f.track !== this.videoTrack?.number && f.track !== this.audioTrack?.number) continue;
      this.build(f);
      if (!this.ready) {
        this.waiting.push(f);
        continue;
      }
      if (this.waiting.length) {
        const held = this.waiting;
        this.waiting = [];
        for (const w of held) this.route(w, out);
      }
      this.route(f, out);
    }
    return out;
  }

  private route(f: Frame, out: Output[]): void {
    const r = f.track === this.videoTrack?.number ? this.video : this.audio;
    const o = r?.push(f);
    if (o) out.push(o);
  }

  flush(): Output[] {
    return [this.video?.flush(), this.audio?.flush()].filter((o): o is Output => !!o);
  }

  reset(): void {
    this.waiting = [];
    this.video?.reset();
    this.audio?.reset();
  }

  // Another audio track: its own remuxer, built from its next frame.
  switchAudio(t: Track | undefined): void {
    this.audioTrack = t;
    this.audio = null;
    this.waiting = [];
  }
}
