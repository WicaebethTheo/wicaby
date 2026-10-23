// One playback session (Android core player/Playback.kt): the item, PlaybackInfo with this TV's device profile, the
// direct play or HLS URL for the platform player (AVPlay on Tizen, <video> on webOS), the tracks, the subtitles the
// app draws, the skippable segments, the next episode or queue entry, and the /Sessions/Playing reports.
// A direct play the TV fails to decode falls back once to the server's conversion (B01), at the same position.
import type { BaseItem, MediaSource, MediaStream } from '$shared/models';
import { caps } from '../platform/caps';
import { onWifi } from '../platform/index';
import type { VideoPlayer } from '../platform/player';
import { aniskipSegments } from './aniskip';
import type { Api } from './api';
import { communitySegments } from './community-segments';
import { deviceProfile } from './device-profile';
import { t } from './i18n.svelte';
import { changed } from './load.svelte';
import { embySegments, jellyfinSegments, markPlayedByCredits, mergeSegments, resumeFrom, type Segments } from './segments';
import { coversSource, heightClass, ORIGINAL_BITRATE, QUALITY_PRESETS, qualityRows, type QualityRow } from '$shared/quality-presets';
import { settings } from './settings.svelte';
import { activeCues, loadCues, type Cue } from './subtitles';
import { recall, remember, scopeCtx, type ScopeCtx } from './remembered';
import { showToast } from './toast.svelte';
import { memoryPick, recordTrack } from './track-memory';
import { reporter } from './reporter';
import { syncBuffering, syncLoaded, syncPlayPause, syncSeek, syncStopped } from './syncplay.svelte';
import * as Trakt from './trakt.svelte';
import { loadPreview, type Preview } from './trickplay';
import * as Versions from './versions';

const TICKS_PER_MS = 10_000;
const TEXT_CODECS = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'tx3g', 'text', 'smi', 'ttml'];
const isText = (s: MediaStream) => s.IsTextSubtitleStream ?? TEXT_CODECS.includes((s.Codec ?? '').toLowerCase());
const PROGRESS_MS = 10_000;

export interface Queue {
  ids: string[];
  index: number;
  // A shuffle or a list plays every entry from its start.
  fromStart: boolean;
}

export interface PlaybackOptions {
  fromStart?: boolean;
  // A trailer or bonus: from the start, nothing reported, no watched state, no next episode.
  trailer?: boolean;
  queue?: Queue;
  // Where to start, whatever the resume point (a SyncPlay group's position, a controller's "Play on").
  startMs?: number;
  // The audio and subtitle a controller asked for (X-06), over the details page's pick.
  tracks?: Versions.TrackPick;
}

// The series whose remembered tracks were announced this session (once each, as Android's tracksToasted).
const toasted = new Set<string>();

export class Playback {
  item = $state<BaseItem | null>(null);
  error = $state<string | null>(null);
  streams = $state<MediaStream[]>([]);
  audioIndex = $state<number | null>(null);
  subtitleIndex = $state<number>(-1);
  cues = $state<Cue[]>([]);
  segments = $state<Segments>({ ranges: [] });
  next = $state<BaseItem | null>(null);
  ended = $state(false);
  playing = $state(false);
  buffering = $state(true);
  positionMs = $state(0);
  durationMs = $state(0);
  playMethod = $state<'DirectPlay' | 'DirectStream' | 'Transcode'>('DirectPlay');
  // X-02: the bitrate cap picked in the player (ORIGINAL_BITRATE for Original), kept for the next episodes of this
  // player; null = the Settings cap. switching: a reload is in flight.
  qualityCap = $state<number | null>(null);
  switching = $state(false);
  // The playback rate (X-03), kept for the next episodes of this player.
  rate = $state(1);
  // X-05: where this title's speed and picture format are remembered (null for a trailer).
  scopeCtx = $state<ScopeCtx | null>(null);
  // The source playing and why the server converts it (TranscodeReasons of its URL), for the stats panel.
  source = $state.raw<MediaSource | null>(null);
  transcodeReasons = $state.raw<string[]>([]);
  // Scrub thumbnails; null when the item has none.
  preview = $state.raw<Preview | null>(null);
  // Episodes started by the countdown in a row; any input resets it ("Still watching?").
  autoCount = 0;

  itemId: string;
  private sourceId: string | undefined;
  private playSessionId: string | undefined;
  private started = false;
  private stopped = false;
  private fellBack = false;
  private forceTranscode = false;
  // The WebVTT file could not be fetched (a server without CORS on it): text subtitles are burnt in instead.
  private burnText = false;
  private seq = 0;
  // Each load (the first, a reload for a track, a quality switch, the B01 fallback): a newer one makes the older
  // stop at its next step, so two quick track changes do not run two loads at once. failedLoad: the load whose
  // failure was already handled (the player may both reject its open and report an error).
  private loadSeq = 0;
  private failedLoad = -1;
  // A progressive conversion (an engine without HLS: a desktop browser) starts at the asked position: its time 0 is
  // offsetMs, it has no duration of its own, and a seek asks the server again.
  private progressive = false;
  private offsetMs = 0;
  private timer = 0;
  private offs: (() => void)[] = [];
  private readonly fromStart: boolean;
  private startAt: number | undefined;
  private tracks: Versions.TrackPick | undefined;
  readonly trailer: boolean;
  queue: Queue | null;

  constructor(
    readonly api: Api,
    readonly player: VideoPlayer,
    itemId: string,
    opts: PlaybackOptions = {},
  ) {
    this.itemId = itemId;
    this.fromStart = !!opts.fromStart;
    this.startAt = opts.startMs;
    this.tracks = opts.tracks;
    this.trailer = !!opts.trailer;
    this.queue = opts.queue ?? null;
  }

  // The subtitles showing now, with the offset of an out-of-sync file.
  get activeCues(): Cue[] {
    return this.cues.length ? activeCues(this.cues, this.positionMs) : [];
  }

  start(): void {
    this.offs.push(
      this.player.on('time', (ms) => {
        this.positionMs = ms + this.offsetMs;
        if (!this.progressive) this.durationMs = this.player.durationMs || this.durationMs;
      }),
      this.player.on('buffering', (on) => {
        this.buffering = on;
        syncBuffering(this, on);
      }),
      this.player.on('ended', () => {
        this.ended = true;
        this.playing = false;
      }),
      this.player.on('error', (message) => this.failed(message)),
    );
    this.timer = window.setInterval(() => {
      if (!this.started || this.stopped) return;
      this.playing = !this.player.paused;
      if (this.playing) this.report('/Sessions/Playing/Progress', 'TimeUpdate');
      else if (this.playSessionId) reporter.latest(() => this.api.ping(this.playSessionId!));
    }, PROGRESS_MS);
    void this.open(this.itemId, this.fromStart || (this.queue?.fromStart ?? false));
  }

  private async open(id: string, fromStart: boolean): Promise<void> {
    const seq = ++this.seq;
    try {
      const it = await this.api.item(id);
      if (seq !== this.seq) return;
      this.item = it;
      // The version picked on the details page (remembered per item), else the first.
      const chosen = Versions.selected(it);
      this.sourceId = chosen?.Id;
      this.streams = chosen?.MediaStreams ?? [];
      const asked = this.startAt;
      this.startAt = undefined;
      const start = asked ?? (fromStart || this.trailer ? 0 : resumeFrom((it.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_MS, (it.RunTimeTicks ?? 0) / TICKS_PER_MS));
      if (!this.trailer) {
        this.scopeCtx = await scopeCtx(this.api, it);
        if (seq !== this.seq) return;
        const rate = recall('speed', this.scopeCtx);
        if (typeof rate === 'number' && this.player.speeds.includes(rate)) this.rate = rate;
      }
      // Audio and subtitles picked on the details page go into the first PlaybackInfo.
      const pick = this.tracks ?? Versions.pick(it.Id, chosen?.Id);
      this.tracks = undefined;
      // X-05: the tracks picked earlier in this series, when nothing else asked for some.
      const series = it.SeriesId;
      const mem = !pick && !this.trailer && series ? memoryPick(series, this.streams) : {};
      // Accessibility: the server default swapped for its AD / plain / SDH twin (Versions); null leaves it to the server.
      const a11yAudio = chosen ? Versions.defaultAudioStream(chosen)?.Index : undefined;
      const a11ySub = chosen ? Versions.defaultSubtitleIndex(chosen) : -1;
      const audio = pick?.audio ?? mem.audio ?? (chosen && a11yAudio !== chosen.DefaultAudioStreamIndex ? a11yAudio : undefined) ?? null;
      const subtitle = pick?.subtitle ?? mem.subtitle ?? (chosen && a11ySub >= 0 && a11ySub !== chosen.DefaultSubtitleStreamIndex ? a11ySub : null);
      await this.load(start, audio, subtitle);
      const moved =
        !!chosen && ((mem.audio ?? chosen.DefaultAudioStreamIndex) !== chosen.DefaultAudioStreamIndex || (mem.subtitle ?? Versions.defaultSubtitleIndex(chosen)) !== Versions.defaultSubtitleIndex(chosen));
      if (moved && series && !toasted.has(series)) {
        toasted.add(series);
        showToast(t('tracks_applied'));
      }
      if (seq === this.seq) syncLoaded(this);
      if (this.trailer || seq !== this.seq) return;
      // Off the open path: a large BIF must not delay the segments or the next episode.
      void loadPreview(this.api, it, this.sourceId).then((p) => {
        if (seq === this.seq && !this.stopped) this.preview = p;
        else p?.release();
      });
      const fromServer = this.api.isEmby ? embySegments(it.Chapters) : jellyfinSegments(await this.api.mediaSegments(it.Id).catch(() => []));
      this.segments = fromServer;
      // What the server lacks, from the third parties turned on (off by default): per kind the server wins, then
      // TheIntroDB, then AniSkip (asked while intro, credits or recap is missing; it fills only those).
      const has = (kind: string) => fromServer.ranges.some((r) => r.kind === kind);
      const quiet = (p: Promise<Segments | null>) => p.catch(() => null);
      const community = settings.communitySegments.value && (fromServer.credits === undefined || !has('Intro') || !has('Recap') || !has('Preview'));
      const anime = settings.aniskip.value && it.Type === 'Episode' && (fromServer.credits === undefined || !has('Intro') || !has('Recap'));
      // Asked side by side, each answer applied as it lands (a slow service must not delay the other's intro).
      let c: Segments | null = null;
      let a: Segments | null = null;
      const land = () => {
        if ((c || a) && seq === this.seq && !this.stopped) this.segments = mergeSegments(fromServer, ...[c, a].filter((x): x is Segments => !!x));
      };
      if (community) void quiet(communitySegments(this.api, it)).then((r) => ((c = r), land()));
      if (anime) void quiet(aniskipSegments(this.api, it)).then((r) => ((a = r), land()));
      this.next = (await this.nextFor(it)) ?? null;
    } catch (e) {
      if (seq === this.seq) this.error = e instanceof Error && e.message ? e.message : t('playback_error');
    }
  }

  private async nextFor(it: BaseItem): Promise<BaseItem | undefined> {
    const q = this.queue;
    if (!q) return it.Type === 'Episode' ? this.api.nextEpisode(it).catch(() => undefined) : undefined;
    const id = q.ids[q.index + 1];
    return id ? this.api.item(id).catch(() => undefined) : undefined;
  }

  // switchFrom: runs once the new PlaybackInfo resolved, before anything of the session changes. Until then a failure
  // throws and the old stream plays on (make-before-break).
  private async load(startMs: number, audio: number | null, subtitle: number | null, switchFrom?: () => void): Promise<void> {
    const it = this.item;
    if (!it) return;
    const seq = this.seq;
    const ls = ++this.loadSeq;
    const current = () => seq === this.seq && ls === this.loadSeq;
    const mbps = onWifi() ? settings.mbpsWifi.value : settings.mbpsEthernet.value;
    const maxBitrate = this.qualityCap ?? (mbps > 0 ? mbps * 1_000_000 : 200_000_000);
    const ticks = Math.round(startMs * TICKS_PER_MS);
    // Burning a text subtitle in needs the server's conversion.
    const burn = this.burnText && subtitle !== null && subtitle >= 0 && this.streams.some((m) => m.Index === subtitle && m.Type === 'Subtitle' && isText(m));
    // A picked preset below the source must convert, or the server would direct play it anyway.
    const src = it.MediaSources?.find((m) => m.Id === this.sourceId) ?? it.MediaSources?.[0];
    const video = src?.MediaStreams?.find((m) => m.Type === 'Video');
    const preset = QUALITY_PRESETS.find((p) => p.bitrate === this.qualityCap);
    const below = !!preset && !coversSource(preset, src?.Bitrate, heightClass(video?.Width, video?.Height));
    const force = this.forceTranscode || burn || below;
    const body = {
      DeviceProfile: deviceProfile(await caps(), this.api.kind, maxBitrate, 0, this.burnText),
      UserId: this.api.userId,
      MaxStreamingBitrate: maxBitrate,
      StartTimeTicks: ticks,
      IsPlayback: true,
      AutoOpenLiveStream: true,
      MediaSourceId: this.sourceId,
      AudioStreamIndex: audio ?? undefined,
      SubtitleStreamIndex: subtitle ?? undefined,
      EnableDirectPlay: !force,
      EnableDirectStream: !force,
      EnableTranscoding: true,
      AllowVideoStreamCopy: !force,
      AllowAudioStreamCopy: true,
    };
    const info = await this.api.playbackInfo(
      it.Id,
      { UserId: this.api.userId, StartTimeTicks: ticks, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: maxBitrate, AudioStreamIndex: audio, SubtitleStreamIndex: subtitle, MediaSourceId: this.sourceId },
      body,
    );
    if (!current()) return;
    if (info.ErrorCode) throw new Error(t('playback_error_code', info.ErrorCode));
    const ps = info.MediaSources?.find((s) => s.Id === this.sourceId) ?? info.MediaSources?.[0];
    if (!ps) throw new Error(t('no_playable_source'));
    let url: string | null = null;
    let from = startMs;
    let method: 'DirectPlay' | 'DirectStream' | 'Transcode' = 'DirectPlay';
    let progressive = false;
    if (ps.SupportsDirectPlay && !force) {
      url = this.api.streamUrl(it, ps.Id, info.PlaySessionId);
    } else if (ps.TranscodingUrl) {
      url = this.api.mediaUrl(ps.TranscodingUrl);
      method = /videocodec=copy/i.test(ps.TranscodingUrl) ? 'DirectStream' : 'Transcode';
      // Emby and Jellyfin HLS playlists cover the whole runtime; a server that echoes StartTimeTicks starts there.
      if (ps.StartTimeTicks) from = Math.max(0, startMs - ps.StartTimeTicks / TICKS_PER_MS);
      progressive = (ps.TranscodingSubProtocol ?? '').toLowerCase() !== 'hls' && !/\.m3u8/i.test(ps.TranscodingUrl);
      if (progressive) from = 0;
    }
    if (!url) throw new Error(t('no_playable_source'));
    switchFrom?.();
    this.transcodeReasons = method === 'DirectPlay' ? [] : (/[?&]TranscodeReasons=([^&]+)/i.exec(ps.TranscodingUrl ?? '')?.[1] ?? '').split(/%2C|,/i).filter(Boolean);
    this.playMethod = method;
    this.source = ps;
    this.playSessionId = info.PlaySessionId;
    this.streams = ps.MediaStreams?.length ? ps.MediaStreams : this.streams;
    this.audioIndex = audio ?? ps.DefaultAudioStreamIndex ?? null;
    this.subtitleIndex = subtitle ?? ps.DefaultSubtitleStreamIndex ?? -1;
    this.started = false;
    this.buffering = true;
    this.progressive = progressive;
    this.offsetMs = progressive ? startMs : 0;
    // The position asked, already: a fallback after a failed open starts from it, not from 0.
    this.positionMs = startMs;
    try {
      await this.player.open(url, from);
    } catch (e) {
      // A refused open goes the way of a playback error (B01): on Tizen, a failed prepare may only reject.
      if (current()) this.failed(e instanceof Error ? e.message : '');
      return;
    }
    if (!current()) return;
    if (this.rate !== 1) this.player.setRate(this.rate);
    const runtime = (it.RunTimeTicks ?? 0) / TICKS_PER_MS;
    this.durationMs = progressive ? runtime : this.player.durationMs || runtime;
    this.positionMs = startMs;
    this.player.play();
    this.playing = true;
    this.started = true;
    this.report('/Sessions/Playing', null);
    void this.applySubtitles();
  }

  // A text subtitle the app can draw: the server's WebVTT file, or, for one inside the file that the answer gave no
  // URL for, the same conversion asked by route (both servers extract and convert it). Image subtitles cannot.
  private subtitleUrl(s: MediaStream): string | null {
    if (s.DeliveryMethod === 'External' && s.DeliveryUrl) return this.api.mediaUrl(s.DeliveryUrl);
    if (s.DeliveryMethod === 'Encode' || !isText(s) || !this.source || !this.item) return null;
    return this.api.mediaUrl(`/Videos/${this.item.Id}/${this.source.Id}/Subtitles/${s.Index}/0/Stream.vtt`);
  }

  // The subtitle the app draws (burnt-in ones are part of the picture).
  private async applySubtitles(): Promise<void> {
    const s = this.streams.find((m) => m.Index === this.subtitleIndex && m.Type === 'Subtitle');
    this.cues = [];
    const want = this.subtitleIndex;
    // A download that lands after a reload or on the next episode (same index, another file) is dropped.
    const ls = this.loadSeq;
    const still = () => this.subtitleIndex === want && ls === this.loadSeq && !this.stopped;
    // Read from the file by the player itself, when it can: nothing for the server to extract.
    const embedded = this.subtitles().filter((m) => !m.IsExternal);
    const own = (cues: Cue[]) => {
      if (still()) this.cues = cues;
    };
    if (s && !s.IsExternal && this.playMethod === 'DirectPlay' && this.player.embeddedCues?.(embedded.indexOf(s), own)) return;
    const url = s ? this.subtitleUrl(s) : null;
    if (!url) return;
    try {
      const cues = await loadCues(url);
      if (still()) this.cues = cues;
    } catch {
      // Refused (no CORS on the file) or unreachable: once per session, the server burns the text in.
      if (!still() || this.burnText) return;
      this.burnText = true;
      this.reload();
    }
  }

  private failed(message: string): void {
    if (this.stopped || this.failedLoad === this.loadSeq) return;
    this.failedLoad = this.loadSeq;
    // B01: the TV could not decode the direct play: once per item, the server's conversion from the same position.
    if (this.playMethod === 'DirectPlay' && !this.fellBack && this.item) {
      this.fellBack = true;
      this.forceTranscode = true;
      void this.load(this.positionMs, this.audioIndex, this.subtitleIndex >= 0 ? this.subtitleIndex : null, () => this.endSession(true)).catch(
        (e) => (this.error = e instanceof Error ? e.message : t('playback_error')),
      );
      return;
    }
    this.error = message || t('playback_error');
  }

  // --- Controls ---

  togglePlay(play = this.player.paused): void {
    if (play) this.player.play();
    else this.player.pause();
    this.playing = play;
    this.report('/Sessions/Playing/Progress', play ? 'Unpause' : 'Pause');
    syncPlayPause(this, play);
  }

  setSpeed(rate: number): void {
    this.rate = rate;
    this.player.setRate(rate);
    remember('speed', this.scopeCtx, rate);
  }

  seek(ms: number): void {
    const target = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.positionMs = target;
    this.ended = false;
    syncSeek(this, target);
    if (this.progressive) return this.reload();
    this.player.seek(target);
  }

  audio(): MediaStream[] {
    return this.streams.filter((s) => s.Type === 'Audio');
  }

  subtitles(): MediaStream[] {
    return this.streams.filter((s) => s.Type === 'Subtitle');
  }

  // Direct play switches the TV's own track when it lists them in the file's order; anything else reloads with the
  // track asked of the server, at the same position.
  selectAudio(index: number): void {
    if (index === this.audioIndex) return;
    this.rememberTrack('audio', index);
    const embedded = this.audio().filter((s) => !s.IsExternal);
    const pos = embedded.findIndex((s) => s.Index === index);
    const native = this.player.audioTracks();
    this.audioIndex = index;
    if (this.playMethod === 'DirectPlay' && pos >= 0 && native.length === embedded.length) {
      this.player.selectAudio(native[pos].index);
      this.report('/Sessions/Playing/Progress', 'AudioTrackChange');
    } else this.reload();
  }

  selectSubtitle(index: number): void {
    if (index === this.subtitleIndex) return;
    this.rememberTrack('subtitle', index);
    const was = this.streams.find((s) => s.Index === this.subtitleIndex);
    const now = this.streams.find((s) => s.Index === index);
    this.subtitleIndex = index;
    // Burnt in (an image track) on either side: the picture itself changes; unless the player draws it from the
    // file itself (the phone's remux player: text and PGS).
    const drawn = !!now && !now.IsExternal && this.playMethod === 'DirectPlay' && !!this.player.drawsEmbedded?.(this.subtitles().filter((m) => !m.IsExternal).indexOf(now));
    if (was?.DeliveryMethod === 'Encode' || (now && !drawn && (this.burnText || !this.subtitleUrl(now)))) return this.reload();
    void this.applySubtitles();
    this.report('/Sessions/Playing/Progress', 'SubtitleTrackChange');
  }

  // X-05: a pick during an episode becomes the series default (-1 = subtitles off).
  private rememberTrack(kind: 'audio' | 'subtitle', index: number): void {
    const series = this.item?.SeriesId;
    if (this.trailer || !series) return;
    recordTrack(series, kind, this.streams.find((s) => s.Index === index && index >= 0) ?? null, this.streams);
  }

  private reload(): void {
    void this.load(this.positionMs, this.audioIndex, this.subtitleIndex, () => this.endSession(true)).catch(
      (e) => (this.error = e instanceof Error ? e.message : t('playback_error')),
    );
  }

  // --- X-02 quality and version ---

  get versions(): MediaSource[] {
    return this.item?.MediaSources ?? [];
  }

  get currentSourceId(): string | undefined {
    return this.source?.Id ?? this.sourceId;
  }

  qualityRows(): QualityRow[] {
    const s = this.versions.find((v) => v.Id === this.currentSourceId) ?? this.versions[0];
    const video = s?.MediaStreams?.find((m) => m.Type === 'Video');
    // The title's runtime, not the stream's: a conversion that starts at the resume point is shorter.
    const runtime = (s?.RunTimeTicks ?? this.item?.RunTimeTicks ?? 0) / TICKS_PER_MS;
    return qualityRows({ bitrate: s?.Bitrate, height: heightClass(video?.Width, video?.Height), size: s?.Size, durationMs: runtime || this.durationMs });
  }

  // Reload in place at the current position with another version (null = this one) and cap (null = Original), with
  // the same tracks (the other version's matching ones). The old stream plays on until the new PlaybackInfo
  // resolves; a failure there leaves it playing. True when the switch took.
  async switchQuality(sourceId: string | null, maxBitrate: number | null): Promise<boolean> {
    const it = this.item;
    if (!it || this.switching) return false;
    const target = this.versions.find((v) => v.Id === (sourceId ?? this.currentSourceId)) ?? this.versions[0];
    if (!target) return false;
    const prev = { cap: this.qualityCap, source: this.sourceId };
    const newVersion = target.Id !== this.currentSourceId;
    const audio = newVersion ? sameTrack(this.streams, target.MediaStreams ?? [], this.audioIndex) : this.audioIndex;
    const subtitle = this.subtitleIndex < 0 ? -1 : newVersion ? (sameTrack(this.streams, target.MediaStreams ?? [], this.subtitleIndex) ?? -1) : this.subtitleIndex;
    this.qualityCap = maxBitrate ?? ORIGINAL_BITRATE;
    this.sourceId = target.Id;
    this.switching = true;
    let stopped = false;
    try {
      await this.load(this.positionMs, audio, subtitle, () => {
        stopped = true;
        this.endSession(true);
      });
      if (newVersion) Versions.select(it.Id, target.Id);
      return true;
    } catch (e) {
      if (stopped) this.error = e instanceof Error ? e.message : t('playback_error');
      else {
        this.qualityCap = prev.cap;
        this.sourceId = prev.source;
      }
      return false;
    } finally {
      this.switching = false;
    }
  }

  retry(): void {
    this.error = null;
    // The failed session ends on the server first (a reload, not a finished watch).
    this.endSession(true);
    void this.open(this.itemId, false);
  }

  // The next episode or queue entry, as a new session in the same player.
  advance(auto: boolean): void {
    const n = this.next;
    if (!n) return;
    if (this.queue) this.queue.index++;
    this.autoCount = auto ? this.autoCount + 1 : 0;
    this.switchTo(n.Id);
  }

  // The previous queue entry within the first 5 s, else back to the start.
  previous(): void {
    const q = this.queue;
    if (q && q.index > 0 && this.positionMs <= 5000) {
      q.index--;
      this.switchTo(q.ids[q.index]);
    } else this.seek(0);
  }

  private dropPreview(): void {
    this.preview?.release();
    this.preview = null;
  }

  private switchTo(id: string): void {
    this.dropPreview();
    this.endSession();
    this.player.stop();
    this.itemId = id;
    this.item = null;
    this.next = null;
    this.ended = false;
    this.error = null;
    this.cues = [];
    this.segments = { ranges: [] };
    this.fellBack = false;
    this.forceTranscode = false;
    this.positionMs = 0;
    this.durationMs = 0;
    void this.open(id, this.queue?.fromStart ?? false);
  }

  // --- Reports ---

  private body(event: string | null): Record<string, unknown> {
    return {
      ItemId: this.itemId,
      MediaSourceId: this.source?.Id,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.round(this.positionMs * TICKS_PER_MS),
      IsPaused: this.player.paused,
      IsMuted: false,
      PlayMethod: this.playMethod,
      CanSeek: true,
      RepeatMode: 'RepeatNone',
      AudioStreamIndex: this.audioIndex ?? undefined,
      SubtitleStreamIndex: this.subtitleIndex,
      ...(event ? { EventName: event } : {}),
    };
  }

  private report(path: '/Sessions/Playing' | '/Sessions/Playing/Progress', event: string | null): void {
    if (this.trailer || !this.source || !this.started) return;
    const body = this.body(event);
    // Trakt follows the reports: start (and resume), pause.
    if (this.item && (path === '/Sessions/Playing' || event === 'Unpause' || event === 'Pause'))
      Trakt.scrobble(event === 'Pause' ? 'pause' : 'start', this.api, this.item, this.positionMs, this.durationMs);
    if (path.endsWith('/Progress')) reporter.latest(() => this.api.report(path, body));
    else void reporter.send(() => this.api.report(path, body));
  }

  // The Stopped report, then an explicit "played" when the credits were reached before the server's own 90 % rule.
  // switching: the old session of an in-place reload, never marked played.
  private endSession(switching = false): void {
    if (this.started && !this.trailer && this.source) {
      const pos = this.positionMs;
      const dur = this.durationMs;
      const id = this.itemId;
      const body = this.body(null);
      const credits = this.segments.credits;
      if (this.item && !switching) Trakt.scrobble('stop', this.api, this.item, pos, dur);
      void reporter.send(() => this.api.report('/Sessions/Playing/Stopped', body)).then(async (sent) => {
        if (sent && !switching && markPlayedByCredits(pos, dur, credits)) await this.api.setPlayed(id, true).catch(() => {});
        // Whatever the report did (Android onSessionEnd): the rows on show refetch the new resume point.
        if (!switching) changed();
      });
    }
    // A conversion keeps running on the server until it notices; end it now.
    const sid = this.playSessionId;
    if (sid && this.playMethod !== 'DirectPlay') void this.api.stopEncoding(sid).catch(() => {});
    this.started = false;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.seq++;
    syncStopped(this);
    clearInterval(this.timer);
    this.offs.forEach((off) => off());
    this.dropPreview();
    this.endSession();
    this.player.stop();
  }
}

// Another version's stream with the same type, language and forced flag (the same codec first): index numbers differ
// between versions.
function sameTrack(from: MediaStream[], to: MediaStream[], index: number | null): number | null {
  const s = from.find((m) => m.Index === index);
  if (!s) return null;
  const pool = to.filter((m) => m.Type === s.Type && m.Language === s.Language && !!m.IsForced === !!s.IsForced);
  return (pool.find((m) => m.Codec === s.Codec) ?? pool[0])?.Index ?? null;
}
