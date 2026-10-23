import type { Cue } from '../lib/subtitles';

// The video player the platform provides: AVPlay on Tizen (hardware pipeline, HDR10/HDR10+), a <video> element on
// webOS and in dev. Times are in milliseconds.
export interface Track {
  index: number;
  language: string;
  label: string;
}

export interface PlayerEvents {
  time: (positionMs: number) => void;
  buffering: (on: boolean) => void;
  ended: () => void;
  error: (message: string) => void;
}

export interface PlayerStats {
  bufferMs?: number;
  dropped?: number;
  width?: number;
  height?: number;
}

// The picture format (core Aspect.kt): fit, fill the screen (crop), stretch, zoom (fill, then 4:3 larger).
export type Aspect = 'fit' | 'fill' | 'stretch' | 'zoom';

export interface VideoPlayer {
  open(url: string, startMs?: number): Promise<void>;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  stop(): void;
  readonly durationMs: number;
  readonly positionMs: number;
  readonly paused: boolean;
  audioTracks(): Track[];
  textTracks(): Track[];
  selectAudio(index: number): void;
  selectText(index: number | null): void;
  // The formats this player can draw, in the order OK cycles them.
  readonly aspects: Aspect[];
  setAspect(a: Aspect): void;
  // The playback rates it plays with sound, 1 included; [] when only 1× (AVPlay trick-plays whole speeds, muted).
  readonly speeds: number[];
  setRate(rate: number): void;
  // What the stats panel can read off the player: buffered time ahead, dropped frames, the decoded size.
  stats(): PlayerStats;
  // A player that reads the file itself (the phone's remux) gives the cues of the text subtitle at [position] among
  // the file's subtitle tracks as they are read, so the server does not extract them; false when it cannot.
  embeddedCues?(position: number, onChange: (cues: Cue[]) => void): boolean;
  // Whether embeddedCues would take that subtitle (no reload needed to show it).
  drawsEmbedded?(position: number): boolean;
  on<E extends keyof PlayerEvents>(event: E, cb: PlayerEvents[E]): () => void;
}

// Shared listener bookkeeping for the implementations.
export class Emitter {
  private readonly listeners = new Map<keyof PlayerEvents, Set<(...a: never[]) => void>>();

  on<E extends keyof PlayerEvents>(event: E, cb: PlayerEvents[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  protected emit<E extends keyof PlayerEvents>(event: E, ...args: Parameters<PlayerEvents[E]>): void {
    this.listeners.get(event)?.forEach((cb) => (cb as (...a: Parameters<PlayerEvents[E]>) => void)(...args));
  }
}
