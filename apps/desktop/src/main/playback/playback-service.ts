import { EventEmitter } from 'node:events';
import { powerSaveBlocker } from 'electron';
import {
  MEDIA_SCHEME,
  TICKS_PER_MS,
  type HtmlPlayerEvent,
  type MediaMarkers,
  type PlaybackCommand,
  type PlaybackState,
  type PlayMethod,
  type PlayRequest,
  type SongIdResult,
  type UpNext,
  type VideoAspect,
  ASPECT_MODES,
  Channels,
  ZOOM_STEPS,
} from '../../shared/contract';
import type { BaseItem, MediaSource, MediaStream, PlaybackInfoResponse } from '../../shared/models';
import { partWindow } from '../../shared/plex/decision';
import { buildQuery, isServerOrigin, resolveServerUrl, serverPath } from '../connection/api-client';
import { FilesClient } from '../files/files-client';
import { caps, isLocalSource } from '../../shared/server-caps';
import type { CastSnapshot } from '../cast/cast-manager';
import type { SocketMessage } from '../connection/server-socket';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { DownloadRecord } from '../downloads/download-manager';
import { clearThumbar, setPlaybackThumbar } from '../features/taskbar';
import { buildDeviceProfile } from '../../shared/device-profile';
import { hdrFromStream } from '../../shared/hdr';
import { missingKinds, mergeMarkers } from '../../shared/community-segments';
import { activeSegment, embyMarkers, jellyfinMarkers, SEGMENT_SETTING, type MediaSegment } from '../../shared/markers';
import { coversSource, heightClass, ORIGINAL_BITRATE, QUALITY_PRESETS, qualityRows } from '../../shared/quality-presets';
import { addedSubtitle } from '../../shared/subtitles';
import { dvNeedsReshaping } from './hdr';
import { chromiumHdrCodecs, HtmlPlayer } from './html-player';
import { MpvPlayer } from './mpv-player';
import type { ActivePlayer, ExternalSubtitle, LoadParams, PlaybackStats, TimeUpdate } from './player';
import { selectTracks } from '../../shared/track-selection';
import type { ScopedProp } from './scoped-prefs';
import { userItem } from '../connection/user-routes';
import { isLanAddress } from '../../shared/network';
import { LivePlayback, type LiveRestart } from '../livetv/live-player';
import { ZapController } from '../livetv/zap-controller';
import { MpvAudioPlayer } from '../music/mpv-audio-player';
import { MusicPlayback } from '../music/music-playback';
import {
  errorText,
  idle,
  mediaApiUrl,
  nowPlaying,
  redirectTarget,
  sameTrack,
  sourceLabel,
  sourceLabels,
  sourceSignature,
  subtitleUrl,
  toTrack,
  trackLabel,
  validId,
  videoOf,
  type Current,
  type PlaybackDeps,
  type StartOptions,
} from './playback-model';
import { aniskipFallback, communityFallback, EMBY_SKIP_MODE, jellyfinTrickplay } from './playback-extras';
import { cinemaTrailers, PlayQueue } from './play-queue';
import { PlayerMemory } from './player-memory';
import { handleRemote } from './remote-commands';
import { SessionReporter } from './session-reporter';
import { SleepTimer } from './sleep-timer';
import { identifySong } from './song-id';
import { StreamRecovery } from './stream-recovery';

// The service's types and helpers live in playback-model.ts; live-player.ts imports them from here.
export { idle, mediaApiUrl, nowPlaying, redirectTarget, toTrack, validId, type Current, type PlaybackDeps, type StartOptions } from './playback-model';

const log = logger.scope('playback');

const STILL_WATCHING_EPISODES = 3;
const STILL_WATCHING_IDLE_MS = 2 * 3600_000;
const UP_NEXT_FALLBACK_MS = 30_000;
// A direct-play stream that ends this far before its duration lost its connection (mpv reads a drop as EOF).
const EARLY_EOF_MS = 30_000;

// Owns the play queue, chooses the player, negotiates PlaybackInfo and keeps
// the server informed. Emby split this between JS playbackManager and native
// PlaybackProgressReporter; Wicaby keeps one owner in the main process.
// Its parts: play-queue.ts (queue, cinema mode), session-reporter.ts (server reports), player-memory.ts
// (scoped settings, track and version memory), sleep-timer.ts, remote-commands.ts, playback-extras.ts.
export class PlaybackService extends EventEmitter {
  private readonly queue = new PlayQueue();
  private player: ActivePlayer | null = null;
  // How mpv shows video: deps.mpvRender, until texture mode fails once (D3): then detached for the rest of the session.
  private mpvRender: PlaybackDeps['mpvRender'];
  private current: Current | null = null;
  private state: PlaybackState = idle();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private powerBlocker: number | null = null;
  // The kind blockPower last asked for, taken back on play after a pause (B05).
  private powerVideo = true;
  private loadSeq = 0;
  // Per item: intro auto-skip done once, up-next card dismissed by the user.
  private introSkipped = false;
  private creditsSkipped = false;
  // Recaps, previews and commercials auto-skipped once each (by start), so seeking back into one replays it.
  private segmentsSkipped = new Set<number>();
  private unwatchMinimize: (() => void) | null = null;
  private upNextDismissed = false;
  private exiting: Promise<void> | null = null;
  private upNextTimer: NodeJS.Timeout | null = null;
  private nextInfo: UpNext | null = null;
  // "Toujours là ?" guard: episodes started by the countdown, and the last user command.
  private autoAdvanced = 0;
  private lastInputAt = Date.now();
  // Runs before anything plays here: a DLNA cast this sender reports for stops first (cast-spec §1, index.ts).
  beforePlay: (() => Promise<void>) | null = null;
  // SyncPlay (syncplay.ts): true when the group takes this play request or command instead of this player.
  divert: { play(req: PlayRequest): boolean; command(cmd: PlaybackCommand): boolean; grouped(): boolean } | null = null;

  // X-02: the bitrate cap picked in the player (ORIGINAL_BITRATE for Original), for this play request
  // and its up-next episodes; undefined = the settings cap. switching gates onEnded during a reload.
  private qualityCap: number | undefined;
  private switching = false;

  // Live TV (livetv/live-player.ts): openLive, adoptLive, releaseLive.
  private readonly lives: LivePlayback;
  // Player live mode (livetv/zap-controller.ts): zap list, CH+/-, last channel, LiveState.
  private readonly zap: ZapController;
  // Playing, Progress and Stopped reports and the progress timer (session-reporter.ts).
  private readonly reports: SessionReporter;
  // X-05 scoped settings, track memory and X-02 version memory (player-memory.ts).
  private readonly memory: PlayerMemory;
  // X-04 sleep timer, state.sleep (sleep-timer.ts).
  private readonly sleep: SleepTimer;
  // Reconnection and the one-shot transcode fallback for VOD (stream-recovery.ts), state.reconnecting.
  private readonly recovery: StreamRecovery<Current>;
  // Music (music/music-playback.ts): windowless mpv, gapless queue, loudness, state.music.
  private readonly music: MusicPlayback;

  constructor(private readonly deps: PlaybackDeps) {
    super();
    const self = this;
    this.mpvRender = deps.mpvRender;
    this.memory = new PlayerMemory(deps);
    this.lives = new LivePlayback({
      deps,
      get current() { return self.current; },
      set current(c) { self.current = c; },
      get state() { return self.state; },
      set state(st) { self.state = st; },
      get player() { return self.player; },
      get seq() { return self.loadSeq; },
      supersede: () => void this.loadSeq++,
      get serverId() { return self.queue.serverId; },
      get queue() { return { index: self.queue.index, length: self.queue.ids.length }; },
      setQueue: (id, sid) => ([this.queue.ids, this.queue.index, this.queue.serverId] = [[id], 0, sid]),
      ensurePlayer: (kind) => this.ensurePlayer(kind),
      publish: (now) => this.publish(now),
      reportStopped: (c) => this.reports.stopped(c),
      startItem: (opts) => this.startItem(opts),
      fail: (err) => this.fail(err),
      adoptLive: (video) => this.adoptLive(video),
    });
    this.zap = new ZapController({
      tune: (id) => this.tuneChannel(id),
      publish: () => this.publish(true),
      // A pause-released channel stays the OSD's live channel until "Reprendre le direct".
      current: () => self.current ?? self.lives.releasedChannel,
      api: () => this.deps.connection.onlineApi(this.queue.serverId),
      policy: (sid) => this.lives.session.policy(sid),
      warn: (m, e) => log.warn(m, e),
    });
    this.reports = new SessionReporter({
      deps,
      get current() { return self.current; },
      set current(c) { self.current = c; },
      get state() { return self.state; },
      get serverId() { return self.queue.serverId; },
      lives: this.lives,
      report: (...args) => void this.emit('report', ...args),
      terminated: (c, text) => {
        if (c !== this.current) return;
        // The server owner's words (plex-spec §6.5), shown as sent.
        this.deps.onMessage('info', text);
        void this.stop();
      },
    });
    this.music = new MusicPlayback({
      deps,
      get current() { return self.current; },
      set current(c) { self.current = c; },
      get state() { return self.state; },
      get player() { return self.player; },
      get queue() { return self.queue; },
      publish: (now) => this.publish(now),
      reportStopped: () => this.reports.stopped(),
      reportStart: () => this.reports.start(),
      startItem: (opts) => this.startItem(opts).catch((err) => this.fail(err)),
      play: (req) => this.play(req),
      stop: () => this.stop(),
    });
    this.sleep = new SleepTimer({
      get state() { return self.state; },
      get current() { return self.current; },
      publish: (now) => this.publish(now),
      stop: () => this.stop(),
      pause: () => {
        this.player?.pause();
        this.releasePower();
      },
    });
    this.recovery = new StreamRecovery<Current>({
      // Server streams only: live TV recovers on its own (live-player.ts), a downloaded file has no server.
      target: () => {
        const c = this.current;
        return this.state.active && c && !c.live && !c.offline && !c.local ? c : null;
      },
      itemId: (c) => c.item.Id,
      direct: (c) => c.playMethod !== 'Transcode',
      reachable: (c) => this.deps.connection.recheck(c.serverId ?? ''),
      // Like restart(): the dead session is reported stopped, then the same item, version and tracks at the position.
      reload: async (c) => {
        const startMs = this.state.positionMs;
        if (this.current) await this.reports.stopped();
        await this.startItem({
          startMs,
          mediaSourceId: c.source?.Id,
          audioStreamIndex: c.audioIndex ?? undefined,
          subtitleStreamIndex: c.subtitleIndex === null ? -1 : c.subtitleIndex,
          player: c.kind,
        });
      },
      fail: (message) => this.fail(new Error(message || t('errors.playback.connectionLost'))),
      publish: () => this.publish(true),
      notice: (key) => {
        this.state.notice = { key, at: Date.now() };
        this.publish(true);
      },
      log: (message) => log.info(message),
    });
    // Stall watchdog: mpv sends nothing while a dead connection keeps it paused for cache. Not between a
    // reload's Stopped report and its new stream (no current): that wait is the recovery's own.
    setInterval(() => {
      if (this.state.active && this.current && !this.current.live) this.recovery.tick(this.state.buffering && !this.state.paused);
    }, 5000).unref();
    // Subtitle look, filters and volume ceiling follow the settings while playing.
    deps.settings.on('change', () => {
      if (this.player instanceof MpvPlayer) void this.player.applySettings();
    });
  }

  getState(): PlaybackState {
    return this.state;
  }

  // Server of the queue being played, if any.
  get serverId(): string | undefined {
    return this.state.active ? this.queue.serverId : undefined;
  }

  // D8: the music queue of the last run, paused, once its server is signed in (index.ts, on session changes).
  restoreMusic(): void {
    this.music.restore();
  }

  // The running mpv, for its live audio-device-list.
  get mpv(): MpvPlayer | null {
    return this.player instanceof MpvPlayer ? this.player : null;
  }

  // "What's this song?" in a film or episode (mpv only: it reads mpv's cache).
  identifySong(): Promise<SongIdResult> {
    return identifySong(this.state.active ? this.mpv : null, this.deps.mpvExe());
  }

  private publish(immediate = false): void {
    this.state.live = this.state.active ? this.zap.state() : undefined;
    this.state.reconnecting = this.state.active ? this.recovery.state : undefined;
    this.state.music = this.music.active ? this.music.state() : undefined;
    if (this.state.live) Object.assign(this.state.live, { timeshift: this.lives.timeshift(), pausedReleased: this.lives.releasedChannel ? true : undefined });
    // Live: the Quality column only, every preset (a channel's bitrate is unknown before it plays).
    if (this.state.live) {
      this.state.qualityOptions ??= { versions: [], rows: qualityRows({}) };
      this.state.currentQuality ??= { maxBitrate: this.qualityCap === undefined || this.qualityCap >= ORIGINAL_BITRATE ? null : this.qualityCap };
    }
    if (immediate) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
      this.emit('state', this.state);
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('state', this.state);
    }, 250);
  }

  private choosePlayer(requested: 'mpv' | 'html' | undefined, item: BaseItem): 'mpv' | 'html' {
    const pb = this.deps.settings.value.playback;
    // "Lecteur par type de contenu", else the global choice.
    const type =
      item.Type === 'TvChannel' || item.Type === 'Program' || item.Type === 'Recording' ? 'live' : item.MediaType === 'Audio' ? 'music' : item.Type === 'Episode' ? 'episode' : item.Type === 'Movie' ? 'movie' : null;
    const byType = type ? pb.playerByType[type] : 'default';
    const pref = requested ?? (byType !== 'default' ? byType : pb.player);
    const hasMpv = this.mpvAvailable(item.MediaType === 'Audio');
    if (pref === 'html') return 'html';
    if (pref === 'mpv' && !hasMpv) {
      this.deps.onMessage('info', t('main.playback.mpvMissing'));
      return 'html';
    }
    return hasMpv ? 'mpv' : 'html';
  }

  async play(req: PlayRequest): Promise<void> {
    // Queue ids end up in API paths (item, PlaybackInfo, Similar, up next).
    const ids = (req.itemIds ?? []).filter(validId).slice(0, 1000);
    if (ids.length === 0) throw new Error(t('errors.playback.nothingToPlay'));
    if (this.divert?.play({ ...req, itemIds: ids })) return;
    // Play next / add to queue: spliced into the queue playing on the same server, else played now
    // (a live channel never ends, so over one it plays now too).
    if ((req.command === 'PlayNext' || req.command === 'PlayLast') && this.state.active && !this.current?.live && (!req.serverId || req.serverId === this.queue.serverId)) {
      this.queue.add(req.command, ids);
      this.music.queueChanged();
      // The up-next card names what now follows.
      const next = this.queue.nextId;
      if (next && next !== this.nextInfo?.id) void this.upNextAfter(undefined, !this.state.offline, () => false).then((n) => (this.nextInfo = n), () => undefined);
      this.state.queueLength = this.queue.ids.length;
      this.publish(true);
      return;
    }
    await this.beforePlay?.();
    const wasLive = Boolean(this.current?.live?.adopted);
    // A live channel being left stays open until the next start knows what it is (make-before-break).
    if (!this.current?.live?.adopted) await this.reports.stopped();
    this.queue.reset(ids, req.serverId ?? this.deps.connection.primaryId, req.startIndex ?? 0, req.trailer === true);
    this.autoAdvanced = 0;
    this.lastInputAt = Date.now();
    this.qualityCap = undefined;
    this.recovery.reset();
    const opts: StartOptions = {
      // Resuming rewinds 5 s so the viewer catches the line they left on.
      startMs: req.startPositionTicks ? Math.max(0, req.startPositionTicks / TICKS_PER_MS - 5000) : 0,
      mediaSourceId: req.mediaSourceId,
      audioStreamIndex: req.audioStreamIndex,
      subtitleStreamIndex: req.subtitleStreamIndex,
      player: req.player,
    };
    // Cinema mode: never when resuming, only before a film, never in a SyncPlay group (the group plays its own queue).
    if (this.deps.settings.value.playback.cinemaMode && !req.trailer && !req.startPositionTicks && !this.divert?.grouped()) {
      const intros = await cinemaTrailers(this.deps.connection.onlineApi(this.queue.serverId), this.queue.id).catch((err) => {
        log.debug(`cinema mode: ${String(err)}`);
        return [] as string[];
      });
      if (intros.length) {
        this.queue.addIntros(intros, opts);
        await this.startItem({ player: req.player }).catch((err) => this.fail(err));
        return;
      }
    }
    const settle = this.zap.request(req.live, this.queue.id, wasLive);
    await this.startItem(opts).catch((err) => this.fail(err));
    settle();
  }

  // A zap, a number or the mini-guide: another channel of the same server (livetv/zap-controller.ts).
  // live (X-02): the rung to start from (a quality preset skips direct play).
  private async tuneChannel(id: string, live?: LiveRestart): Promise<void> {
    if (!this.current?.live?.adopted) await this.reports.stopped();
    [this.queue.ids, this.queue.index] = [[id], 0];
    await this.startItem({ player: this.current?.kind ?? this.player?.kind, live }).catch((err) => this.fail(err));
  }

  private async startItem(opts: StartOptions): Promise<void> {
    const seq = ++this.loadSeq;
    const deps = this.deps;
    const settings = deps.settings.value;
    const sid = this.queue.serverId;
    const session = deps.connection.sessionFor(sid);
    const online = session?.status === 'signed-in';
    const itemId = this.queue.id;
    const local: DownloadRecord | undefined = deps.downloads.findDone(itemId, sid);

    let item: BaseItem;
    if (online) item = await userItem<BaseItem>(deps.connection.apiFor(sid), deps.connection.userIdFor(sid), itemId);
    else if (local) item = local.item;
    else throw new Error(t('errors.playback.notOffline'));
    if (seq !== this.loadSeq) return;
    // Every stream, trickplay and report URL below puts the id in a path.
    if (!validId(item.Id)) throw new Error(t('errors.playback.noMediaSource'));

    // A file or IPTV source cannot be transcoded (server-caps.ts transcode: false): mpv whenever there is one.
    const fileSource = isLocalSource(session?.server.kind);
    const kind = fileSource && opts.player !== 'html' && this.mpvAvailable(item.MediaType === 'Audio') ? 'mpv' : this.choosePlayer(opts.player, item);
    if (online && item.Type === 'TvChannel') {
      this.memory.scopeCtx = { global: true };
      return this.lives.openLive(seq, item, kind, { ...opts, maxBitrate: this.qualityCap });
    }
    await this.lives.leave();
    // Downloads (and anything offline) use the global value.
    const scopeCtx = await this.memory.scopeCtxFor(sid, item, !online || Boolean(local));
    if (seq !== this.loadSeq) return;
    this.memory.scopeCtx = scopeCtx;
    // The remembered speed, else "Vitesse par défaut", for films and episodes; live TV and music start at 1×.
    const savedRate = this.memory.recall('speed');
    const rate =
      item.MediaType === 'Video' && item.Type !== 'TvChannel'
        ? typeof savedRate === 'number' && savedRate >= 0.25 && savedRate <= 4
          ? savedRate
          : settings.playback.defaultSpeed
        : 1;
    // The version asked for, else the one picked earlier in this series (X-02), else the server's default.
    const remembered = item.SeriesId && (item.MediaSources?.length ?? 0) > 1 ? this.memory.versionFor(item.SeriesId) : undefined;
    let source =
      item.MediaSources?.find((s) => s.Id === opts.mediaSourceId) ??
      (remembered ? item.MediaSources?.find((s) => sourceSignature(s) === remembered) : undefined) ??
      item.MediaSources?.[0];
    let streams = source?.MediaStreams ?? item.MediaStreams ?? [];
    const pb = settings.playback;
    const plexSubs = deps.connection.plexSubtitles(sid);
    const picked = selectTracks(
      streams,
      { audio: source?.DefaultAudioStreamIndex, subtitle: source?.DefaultSubtitleStreamIndex },
      {
        audioLanguage: pb.preferredAudioLanguage,
        // Plex (plex-spec §6.4, #1182): no language of our own and the "server default" mode follow the account's.
        subtitleLanguage: pb.preferredSubtitleLanguage || plexSubs?.language || '',
        mode: pb.subtitleMode === 'default' ? (plexSubs?.mode ?? 'default') : pb.subtitleMode,
        forced: pb.alwaysForced,
        sdh: pb.preferSdh,
        audioDescription: pb.audioDescription,
      },
      // B04: a film remembers its own pick (resume), an episode the series'.
      this.memory.tracksFor(item.SeriesId ?? item.Id),
      opts.audioStreamIndex,
      opts.subtitleStreamIndex,
    );
    const audioIndex = picked.audio;
    let subtitleIndex = picked.subtitle;
    let startMs = opts.startMs ?? 0;
    const title = item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name;
    // A file source (file-sources-spec §5.1): no PlaybackInfo, the file itself (path, or the loopback relay).
    const files = online ? deps.connection.clientOf(sid) : null;

    let load: LoadParams;
    let playMethod: PlayMethod = 'DirectPlay';
    let playSessionId: string | undefined;
    // A Plex transcode that starts at the resume point, or a part of a multi-part film (Current.baseMs, partEndMs).
    let baseMs = 0;
    let partEndMs: number | undefined;
    // A Plex server without Plex Pass transcodes without hardware acceleration: said once (explainPass).
    let softTranscode = false;
    const embeddedOf = (type: string) => streams.filter((s) => s.Type === type && !s.IsExternal).map((s) => s.Index);
    const hdrOf = () => hdrFromStream(streams.find((s) => s.Type === 'Video'));

    if (files instanceof FilesClient) {
      const container = (source?.Container ?? '').toLowerCase();
      if (kind === 'html' && !['mp4', 'm4v', 'webm', 'mkv', 'mov'].includes(container)) throw new Error(t('files.error.needsMpv'));
      const target = await files.playTarget(item.Id, kind, (path) => mediaApiUrl(path, sid));
      if (seq !== this.loadSeq) return;
      if (target.changed) {
        deps.onMessage('info', t('files.resume.changed'));
        startMs = 0;
      }
      if (!item.RunTimeTicks && target.durationMs > 0) item.RunTimeTicks = Math.round(target.durationMs * TICKS_PER_MS);
      load = {
        url: target.url,
        isHls: false,
        httpHeaders: [],
        startMs,
        title,
        volume: this.state.volume,
        muted: this.state.muted,
        audioIndex,
        subtitleIndex,
        embeddedAudio: [],
        embeddedSubtitles: [],
        externalSubtitles: target.subtitles,
        tracksFixed: false,
        hdr: null,
        rate,
      };
    } else if (local?.filePath) {
      load = {
        url: kind === 'mpv' ? local.filePath : `${MEDIA_SCHEME}://local/${encodeURIComponent(local.id)}`,
        isHls: false,
        httpHeaders: [],
        startMs,
        title,
        volume: this.state.volume,
        muted: this.state.muted,
        audioIndex,
        subtitleIndex,
        embeddedAudio: embeddedOf('Audio'),
        embeddedSubtitles: embeddedOf('Subtitle'),
        externalSubtitles: [],
        tracksFixed: false,
        hdr: hdrOf(),
        rate,
      };
    } else {
      const api = deps.connection.apiFor(sid);
      const userId = deps.connection.userIdFor(sid);
      const audio = streams.filter((s) => s.Type === 'Audio');
      const defaultAudio = (audio.find((a) => a.IsDefault) ?? audio[0])?.Index;
      // Chromium plays only the default audio track; anything else is remuxed by the server.
      const forceStream = kind === 'html' && audioIndex !== null && defaultAudio !== undefined && audioIndex !== defaultAudio;
      // HDR reaches <video> only by direct play. Unless Chromium decodes that codec as HDR (and the
      // stream has an HDR10/HLG base layer), let the server transcode and tone-map instead.
      let forceToneMap = false;
      const hdr = hdrOf();
      if (kind === 'html' && hdr && hdr.kind !== 'sdr') {
        const codec = (streams.find((s) => s.Type === 'Video')?.Codec ?? '').toLowerCase().replace('h265', 'hevc');
        forceToneMap = dvNeedsReshaping(hdr) || !(await chromiumHdrCodecs(deps.windows)).has(codec);
        if (seq !== this.loadSeq) return;
      }
      // Separate caps for the LAN and for a remote address (the one this session reached), unless
      // the player's Quality sheet picked one (X-02).
      const lan = isLanAddress(api.address);
      const maxBitrate = this.qualityCap ?? Math.round((lan ? pb.maxBitrateMbps : pb.maxBitrateRemoteMbps) * 1_000_000);
      // "Forcer le transcodage" needs the same: no direct play, no video stream copy. So does a picked
      // preset below the source (X-02), or the server would direct play it anyway; it also caps the height.
      const preset = QUALITY_PRESETS.find((q) => q.bitrate === this.qualityCap);
      // Or the item fell back to a transcode after direct play failed (stream-recovery.ts).
      if (pb.forceTranscode || this.recovery.transcodes(item.Id) || (preset && !coversSource(preset, source?.Bitrate, heightClass(videoOf(source)?.Width, videoOf(source)?.Height)))) forceToneMap = true;
      const maxHeight = preset ? Math.min(preset.height, pb.maxResolution || Infinity) : pb.maxResolution;
      const ticks = Math.round(startMs * TICKS_PER_MS);
      const info = await api.post<PlaybackInfoResponse>(
        `/Items/${item.Id}/PlaybackInfo`,
        {
          UserId: userId,
          StartTimeTicks: ticks,
          IsPlayback: true,
          AutoOpenLiveStream: true,
          MaxStreamingBitrate: maxBitrate,
          MediaSourceId: source?.Id,
          AudioStreamIndex: audioIndex ?? undefined,
          SubtitleStreamIndex: subtitleIndex ?? undefined,
        },
        {
          DeviceProfile: buildDeviceProfile(kind, maxBitrate, api.kind, maxHeight),
          PlaySessionId: opts.playSessionId,
          UserId: userId,
          MediaSourceId: source?.Id,
          AudioStreamIndex: audioIndex ?? undefined,
          SubtitleStreamIndex: subtitleIndex ?? undefined,
          MaxStreamingBitrate: maxBitrate,
          StartTimeTicks: ticks,
          IsPlayback: true,
          AutoOpenLiveStream: true,
          EnableDirectPlay: !forceStream && !forceToneMap,
          EnableDirectStream: !forceToneMap,
          EnableTranscoding: true,
          AllowVideoStreamCopy: !forceToneMap,
          AllowAudioStreamCopy: true,
        },
      );
      if (seq !== this.loadSeq) return;
      if (info.ErrorCode) throw new Error(errorText(info.ErrorCode));
      let ps = info.MediaSources?.find((s) => s.Id === source?.Id) ?? info.MediaSources?.[0];
      if (!ps) throw new Error(t('errors.playback.noMediaSource'));
      // Live TV: a tuner source the server did not auto-open must be opened
      // first; its LiveStreamId then rides on the stream URL and every report.
      if (ps.RequiresOpening && !ps.LiveStreamId) {
        const opened = await api.post<{ MediaSource?: MediaSource }>(
          '/LiveStreams/Open',
          {
            UserId: userId,
            ItemId: item.Id,
            PlaySessionId: info.PlaySessionId,
            StartTimeTicks: ticks,
            MaxStreamingBitrate: maxBitrate,
            AudioStreamIndex: audioIndex ?? undefined,
            SubtitleStreamIndex: subtitleIndex ?? undefined,
          },
          { DeviceProfile: buildDeviceProfile(kind, maxBitrate, api.kind, maxHeight), OpenToken: ps.OpenToken },
        );
        if (!opened.MediaSource) throw new Error(t('errors.playback.liveStreamFailed'));
        ps = opened.MediaSource;
      }
      source = ps;
      streams = ps.MediaStreams ?? streams;
      playSessionId = info.PlaySessionId;
      // A programme or a recording in progress can come with a tuner stream: released through the ledger.
      if (ps.LiveStreamId && !this.lives.vodStream(api, sid, item.Id, playSessionId, ps, seq !== this.loadSeq)) return;

      let url: string;
      let isHls = false;
      let tracksFixed = false;
      // The token only goes to the server's own origin; a stream elsewhere plays without it.
      let ownOrigin = true;
      if (ps.SupportsDirectPlay && !forceStream && !forceToneMap) {
        const path = `/${item.MediaType === 'Audio' ? 'Audio' : 'Videos'}/${item.Id}/stream`;
        const q = { Static: true, MediaSourceId: ps.Id, PlaySessionId: playSessionId, DeviceId: deps.deviceId, LiveStreamId: ps.LiveStreamId };
        url = kind === 'mpv' ? api.url(path, q) : mediaApiUrl(path + buildQuery(q), sid);
        if (kind === 'mpv') {
          // A strm or remote source can answer with a redirect, which FFmpeg would follow
          // with the auth header: a target on another origin is played without it.
          const target = await redirectTarget(api, url);
          if (seq !== this.loadSeq) return;
          if (target) {
            url = target;
            ownOrigin = false;
          }
        }
        // A Plex film in several parts (D-4): one mpv timeline over every part, reported under the one item; the
        // HTML player plays the part the start falls in, then the next one (partEndMs).
        const parts = ps.PartPaths ?? [];
        if (kind === 'mpv' && ownOrigin && parts.length > 1) url = `edl://${parts.map((part) => ((u) => `%${Buffer.byteLength(u)}%${u}`)(api.url(part.path))).join(';')}`;
        else if (kind === 'html' && parts.length > 1) {
          const at = partWindow(parts, startMs);
          if (at) {
            url = mediaApiUrl(parts[at.index].path, sid);
            baseMs = at.startMs;
            partEndMs = at.endMs;
          }
        }
      } else if (ps.TranscodingUrl) {
        ownOrigin = isServerOrigin(api, ps.TranscodingUrl);
        if (kind === 'mpv') {
          // Only http(s): never a UNC '//host', file:, smb:, edl: or av: URL.
          const resolved = resolveServerUrl(api, ps.TranscodingUrl);
          if (!resolved) throw new Error(t('errors.playback.noPlayMethod'));
          url = resolved;
        } else {
          // wicaby-media://api only reaches the server itself.
          const rel = serverPath(api, ps.TranscodingUrl);
          if (rel === null) throw new Error(t('errors.playback.noPlayMethod'));
          url = mediaApiUrl(rel, sid);
        }
        isHls = (ps.TranscodingSubProtocol ?? '').toLowerCase() === 'hls' || /\.m3u8/i.test(ps.TranscodingUrl);
        playMethod = /videocodec=copy/i.test(ps.TranscodingUrl) ? 'DirectStream' : 'Transcode';
        tracksFixed = true;
        // Plex: the stream already starts at the resume point; seeking there would ask for segments it never makes.
        if (ps.StartTimeTicks) baseMs = ps.StartTimeTicks / TICKS_PER_MS;
        // A multi-part film: the transcode covers the part the start falls in (decision.ts partAt).
        if ((ps.PartPaths?.length ?? 0) > 1) partEndMs = partWindow(ps.PartPaths!, baseMs)?.endMs;
        softTranscode = info.PlexPass === false && playMethod === 'Transcode';
      } else {
        throw new Error(t('errors.playback.noPlayMethod'));
      }

      const external: ExternalSubtitle[] = streams
        // mpv sends the stream's headers with sub-add: a subtitle on another origin is left out.
        .filter((s) => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl && isServerOrigin(api, s.DeliveryUrl))
        .flatMap((s) => {
          const sub = subtitleUrl(api, kind, s.DeliveryUrl!, sid);
          return sub ? [{ index: s.Index, url: sub, label: trackLabel(s), language: s.Language }] : [];
        });
      // A subtitle the server burns in is already part of the picture.
      if (tracksFixed && subtitleIndex !== null && !external.some((e) => e.index === subtitleIndex)) {
        const burned = streams.find((s) => s.Index === subtitleIndex)?.DeliveryMethod === 'Encode';
        if (!burned) subtitleIndex = null;
      }
      load = {
        url,
        isHls,
        // mpv only (wicaby-media:// adds its own), and never for another origin.
        httpHeaders: kind === 'mpv' && ownOrigin ? api.mediaAuthHeaders() : [],
        // A transcode starts at the resume point; a part of a multi-part film counts from its own start.
        startMs: tracksFixed && baseMs ? 0 : startMs - baseMs,
        title,
        volume: this.state.volume,
        muted: this.state.muted,
        audioIndex,
        subtitleIndex,
        embeddedAudio: embeddedOf('Audio'),
        embeddedSubtitles: streams.filter((s) => s.Type === 'Subtitle' && !s.IsExternal && s.DeliveryMethod !== 'External').map((s) => s.Index),
        externalSubtitles: external,
        tracksFixed,
        hdr: hdrOf(),
        rate,
      };
    }

    // X-02 switch: the old session ends only now that the new one is ready.
    if (opts.beforeLoad) {
      await opts.beforeLoad();
      if (seq !== this.loadSeq) return;
    }
    const video = streams.find((s) => s.Type === 'Video');
    let wasFullscreen = false;
    if (kind === 'mpv' && settings.playback.hdrAutoSwitch && (load.hdr?.kind ?? 'sdr') !== 'sdr') {
      const bounds = (this.player?.hostWindow ?? deps.windows.main)?.getBounds();
      if (bounds && (await deps.hdr.enableFor(bounds)) && this.player) {
        // mpv picks its swapchain colour space at startup; a fresh one sees the HDR desktop.
        const old = this.player;
        wasFullscreen = old.isFullscreen();
        this.player = null;
        await old.destroy();
      }
      if (seq !== this.loadSeq) return;
    }

    const music = item.MediaType === 'Audio';
    const player = await this.ensurePlayer(kind, music);
    if (seq !== this.loadSeq) return;
    // The fresh mpv opens windowed (Start in Full Screen off): full screen chosen with F stays.
    if (wasFullscreen && !player.isFullscreen()) player.setFullscreen(true);
    if (music) {
      load.music = await this.music.prepare(item);
      if (seq !== this.loadSeq) return;
    }
    const saved = this.memory.recall('aspect') as Partial<VideoAspect> | undefined;
    const aspect: VideoAspect =
      saved && ASPECT_MODES.includes(saved.mode!)
        ? { mode: saved.mode!, zoom: ZOOM_STEPS.includes(saved.zoom ?? NaN) ? saved.zoom! : 1.25 }
        : { mode: settings.playback.aspect, zoom: 1.25 };
    player.setAspect(aspect);
    const trailer = this.queue.trailers.has(itemId);

    if (settings.playback.matchRefreshRate && video) {
      await deps.display.matchContent(player.hostWindow, video.RealFrameRate ?? video.AverageFrameRate);
      if (seq !== this.loadSeq) return;
      // Texture mode tells mpv the display's rate itself (load() checks again).
      if (player instanceof MpvPlayer) player.refreshDisplayFps();
    }

    this.current = {
      item,
      source,
      playSessionId,
      playMethod,
      offline: !online,
      // A file source has no server to reconnect to or transcode on.
      local: Boolean(local?.filePath) || files instanceof FilesClient,
      files: files instanceof FilesClient || undefined,
      baseMs: baseMs || undefined,
      partEndMs,
      serverId: sid,
      userId: session?.user?.id ?? session?.server.userId,
      audioIndex,
      subtitleIndex,
      kind,
      trailer,
      external: load.externalSubtitles,
    };
    this.lives.adoptVod(source);
    this.state = {
      ...idle(this.state.volume, this.state.muted),
      active: true,
      player: kind,
      item: nowPlaying(item, sid),
      positionMs: startMs,
      durationMs: (item.RunTimeTicks ?? 0) / TICKS_PER_MS,
      buffering: true,
      audioTracks: streams.filter((s) => s.Type === 'Audio').map(toTrack),
      subtitleTracks: streams.filter((s) => s.Type === 'Subtitle').map(toTrack),
      audioIndex,
      subtitleIndex,
      playMethod,
      queueIndex: this.queue.index,
      queueLength: this.queue.ids.length,
      fullscreen: player.isFullscreen(),
      offline: !online,
      markers: embyMarkers(item.Chapters ?? source?.Chapters),
      skipMode: settings.playback.skipIntro,
      creditsSkipMode: settings.playback.skipCredits,
      rate,
      aspect,
      trailer: trailer || undefined,
      sleep: this.state.sleep, // survives episode changes
      // No quality menu for a file source (caps transcode: false).
      ...(online && !trailer && !(files instanceof FilesClient) ? this.qualityState(item, source) : {}),
    };
    // X-05: once per series and run, when the memory changed the tracks.
    if (picked.applied && item.SeriesId && this.memory.firstToast(item.SeriesId)) {
      this.state.notice = { key: 'player.tracks.applied', at: Date.now() };
    }
    if (softTranscode) this.explainPass('plex.pass.transcode');
    this.creditsSkipped = false;
    this.segmentsSkipped.clear();
    this.clearUpNext();
    this.introSkipped = false;
    this.upNextDismissed = false;
    this.nextInfo = null;
    this.publish(true);
    log.info(`playing ${title} with ${kind} (${playMethod}${local ? ', local file' : ''})`);
    this.recovery.onLoad(item.Id, startMs);
    await player.load(load);
    if (seq !== this.loadSeq) return;
    if (player instanceof MpvPlayer) {
      // A remembered delay. mpv carries the audio delay over between files (the subtitle one is reset):
      // kept only when remembering is off, so another title's delay never leaks in.
      for (const [prop, kind] of [['audioDelay', 'audio'], ['subtitleDelay', 'subtitle']] as const) {
        const ms = this.memory.recall(prop);
        if (typeof ms === 'number' && Number.isFinite(ms)) void player.setDelay(kind, ms);
        else if (kind === 'audio' && this.deps.settings.value.playback.rememberScopes.audioDelay !== 'off') void player.setDelay('audio', 0);
      }
    }
    this.reports.start();
    this.reports.startTimer();
    this.blockPower(Boolean(video));
    this.updateThumbar();
    void this.loadExtras(seq, item, source, online);
  }

  // Whether mpv can play: the mpv CLI, or for video in texture mode libmpv alone (music always runs the CLI).
  private mpvAvailable(audio: boolean): boolean {
    return Boolean(this.deps.mpvExe()) || (!audio && this.mpvRender === 'texture');
  }

  // audio: a track, which mpv plays windowless (music/mpv-audio-player.ts).
  private async ensurePlayer(kind: 'mpv' | 'html', audio = false): Promise<ActivePlayer> {
    // A video player left in texture mode after the switch to detached is replaced.
    const sameMode = !(this.player instanceof MpvPlayer) || this.player.mode === this.mpvRender;
    if (this.player?.kind === kind && sameMode && (kind === 'html' || this.player instanceof MpvAudioPlayer === audio)) return this.player;
    if (this.player) {
      const old = this.player;
      this.player = null;
      await old.destroy();
    }
    const deps = this.deps;
    const player: ActivePlayer =
      kind === 'html'
        ? new HtmlPlayer(deps.windows)
        : audio
          ? await MpvAudioPlayer.create(deps.mpvExe()!, deps.windows, () => deps.settings.value)
          : await this.createMpvPlayer();
    this.attach(player);
    this.player = player;
    this.watchMinimize(player);
    return player;
  }

  // Texture mode that fails to start falls back to mpv's own window at once, when there is an mpv CLI.
  private async createMpvPlayer(): Promise<MpvPlayer> {
    const deps = this.deps;
    const create = () => MpvPlayer.create(deps.mpvExe(), deps.windows, () => deps.settings.value, deps.mpvConfigDir, this.mpvRender);
    if (this.mpvRender !== 'texture') return create();
    try {
      return await create();
    } catch (err) {
      if (!deps.mpvExe()) throw err;
      this.leaveTexture(err instanceof Error ? err.message : String(err));
      return create();
    }
  }

  // D3: texture mode does not work on this machine (render thread, buffer import, libmpv itself): detached until the
  // app restarts. index.ts's probe cannot catch everything (a driver that renders but whose buffers Chromium cannot
  // import, a libmpv build that refuses an option).
  private leaveTexture(reason: string): void {
    if (this.mpvRender !== 'texture') return;
    this.mpvRender = 'detached';
    log.warn(`texture mode failed (${reason}): mpv plays in its own window until restart`);
  }

  private attach(player: ActivePlayer): void {
    player.on('time', (t: TimeUpdate) => {
      if (this.player !== player || !this.state.active) return;
      // A Plex transcode that starts at the resume point counts from 0 there.
      const base = this.current?.baseMs;
      if (base) t = { ...t, positionMs: t.positionMs + base, durationMs: t.durationMs > 0 ? t.durationMs + base : t.durationMs };
      // A part of a multi-part film: the player's duration is the part's, the film's stays.
      if (this.current?.partEndMs) t = { ...t, durationMs: 0 };
      const pausedChanged = t.paused !== this.state.paused;
      this.state.positionMs = t.positionMs;
      if (t.durationMs > 0) this.state.durationMs = t.durationMs;
      // A file source learns its duration here: the progress reports carry it (session-reporter.ts body()).
      const c = this.current;
      if (t.durationMs > 0 && c?.files) {
        c.item.RunTimeTicks = Math.round(t.durationMs * TICKS_PER_MS);
        // Tags at first play (D5): the container title once the file is loaded, cached with its progress.
        const files = this.deps.connection.clientOf(c.serverId);
        if (c.files === true && player instanceof MpvPlayer && files instanceof FilesClient) {
          c.files = 'tagged';
          void player.mediaTitle().then((tag) => files.cacheTitle(c.item.Id, tag), () => undefined);
        }
      }
      this.state.paused = t.paused;
      this.state.buffering = t.buffering;
      this.state.fullscreen = player.isFullscreen();
      this.recovery.onTime({ positionMs: t.positionMs, buffering: t.buffering, cacheBytes: t.cache ? t.cache.fwBytes + t.cache.fileBytes : undefined });
      this.lives.onTime(t);
      this.music.onTime();
      this.onTick(pausedChanged);
      if (pausedChanged) {
        this.pausePower(t.paused);
        this.reports.progress(t.paused ? 'Pause' : 'Unpause');
        this.updateThumbar();
        this.publish(true);
      } else {
        this.publish();
      }
    });
    // mpv's first picture of a file, at once rather than on the next coalesced time update: the OSD lifts its
    // opening veil on it (OsdWindow.svelte).
    player.on('first-frame', () => {
      if (this.player !== player || !this.state.active) return;
      this.recovery.onStarted();
      if (!this.state.buffering) return;
      this.state.buffering = false;
      this.publish(true);
    });
    player.on('volume', (v: { volume: number; muted: boolean }) => {
      this.state.volume = v.volume;
      this.state.muted = v.muted;
      this.publish();
    });
    // A player raises a player.notice.* key; the OSD translates it.
    player.on('notice', (key: string) => {
      this.state.notice = { key, at: Date.now() };
      this.publish(true);
    });
    player.on('stats', (stats: PlaybackStats) => {
      this.state.stats = { ...this.state.stats, ...stats };
      this.publish();
    });
    player.on('ended', () => {
      if (this.player !== player || this.switching || this.lives.onEnded()) return;
      const c = this.current;
      const s = this.state;
      // The end of one part of a multi-part film (D-4): the next one, from its start.
      if (c?.partEndMs && !c.terminated) {
        s.positionMs = c.partEndMs;
        return void this.restart({ part: true });
      }
      // Direct play only: there positions and duration are the file's own.
      if (c && !c.live && !c.local && !c.offline && c.playMethod === 'DirectPlay' && s.durationMs > 0 && s.positionMs < s.durationMs - EARLY_EOF_MS) {
        void this.recovery.onFailure('', 'early-eof');
      } else void this.onEnded();
    });
    // kind: 'stream' or 'decode' for a stream the player could not open or play; absent when the player itself died.
    player.on('failure', (message: string, kind?: 'stream' | 'decode') => {
      // An X-02 reload ends the old stream's encode under it.
      if (this.player !== player || this.switching || this.lives.onFailure(message)) return;
      if (kind) void this.recovery.onFailure(message, kind === 'decode' ? 'decode' : 'error');
      else this.fail(new Error(message));
    });
    // mpv's audio or video output would not open (not a passthrough refusal): one transcode retry in direct play
    // of a server item. Live TV and local files keep playing as before (no fallback there).
    player.on('decode-failure', (message: string) => {
      const c = this.current;
      if (this.player === player && c && !c.live && !c.offline && !c.local && c.playMethod !== 'Transcode' && !this.recovery.transcodes(c.item.Id))
        void this.recovery.onFailure(message, 'decode');
    });
    player.on('closed', () => {
      log.info('player window closed');
      // Closed or crashed (mpv-player.ts): nothing may keep a tuner (§8.1 sweep).
      if (this.player === player) void this.stop(false).then(() => this.lives.sweep());
    });
    // Texture mode could not show this video (mpv-player.ts): the same item again, at the same spot, in mpv's own
    // window, or in the built-in player without an mpv CLI. 'texture-failed' (message): sticky, index.ts remembers it.
    player.on('render-failed', (message: string, sticky?: boolean) => {
      if (this.player !== player) return;
      this.leaveTexture(message);
      if (sticky) this.emit('texture-failed', message);
      void this.restart(this.deps.mpvExe() ? {} : { player: 'html' });
    });
    // The mpv watchdog already killed it: carry on in the built-in player at the same spot.
    player.on('hung', () => {
      if (this.player !== player) return;
      this.deps.onMessage('error', t('main.playback.mpvHung'));
      void this.restart({ player: 'html' });
    });
  }

  // "Mettre en pause quand la fenêtre est réduite" (mpv video window or the main window).
  private watchMinimize(player: ActivePlayer): void {
    this.unwatchMinimize?.();
    const win = player.hostWindow;
    if (!win) return;
    const onMinimize = () => {
      if (this.player === player && this.state.active && !this.state.paused && this.deps.settings.value.playback.pauseOnMinimize && !this.music.active) player.pause();
    };
    win.on('minimize', onMinimize);
    this.unwatchMinimize = () => {
      if (!win.isDestroyed()) win.removeListener('minimize', onMinimize);
      this.unwatchMinimize = null;
    };
  }

  handleHtmlEvent(ev: HtmlPlayerEvent): void {
    if (this.player instanceof HtmlPlayer) this.player.handleEvent(ev);
  }

  // ---- Markers, next episode, trick-play ----

  // None of this may delay the first frame, so it lands in a second state update.
  private async loadExtras(seq: number, item: BaseItem, source: MediaSource | undefined, online: boolean): Promise<void> {
    const stale = () => seq !== this.loadSeq;
    if (!validId(item.Id)) return;
    const tasks: Promise<unknown>[] = [];
    if (this.queue.nextId) tasks.push(this.upNextAfter(source?.Id, online, stale).then((n) => !stale() && (this.nextInfo = n)));
    const api = online ? this.reports.online() : null;
    const userId = api?.userId;
    if (api && item.MediaType === 'Video' && item.Type !== 'TvChannel' && !caps(api.kind).localUserData) {
      if (api.kind === 'emby') {
        if (userId) {
          tasks.push(
            api.get<{ Configuration?: { IntroSkipMode?: string } }>(`/Users/${userId}`).then((u) => {
              const mode = EMBY_SKIP_MODE[u?.Configuration?.IntroSkipMode ?? ''];
              if (mode && !stale()) this.state.skipMode = mode;
            }),
          );
        }
        // Emby needs Width; a 404 just means thumbnail extraction is off for the library.
        this.state.trickplay = { kind: 'bif', url: mediaApiUrl(`/Videos/${item.Id}/index.bif${buildQuery({ Width: 320, MediaSourceId: source?.Id })}`, this.queue.serverId) };
      } else {
        tasks.push(
          api.get<{ Items?: MediaSegment[]; PlexPass?: boolean }>(`/MediaSegments/${item.Id}`).then((r) => {
            const markers = jellyfinMarkers(r?.Items);
            if (markers && !stale()) this.state.markers = markers;
            // Plex: intro and credits detection is a Plex Pass feature of the server (D-5: no client-side detection).
            if (!markers && r?.PlexPass === false && item.Type === 'Episode' && !stale()) this.explainPass('plex.pass.markers');
          }),
        );
        // Plex preview thumbnails are a BIF of the part (/library/parts/{id}/indexes/sd); none when PMS made none.
        if (api.kind === 'plex') {
          if (source?.Bif) this.state.trickplay = { kind: 'bif', url: mediaApiUrl(`/Videos/${item.Id}/index.bif${buildQuery({ MediaSourceId: source.Id })}`, this.queue.serverId) };
        } else tasks.push(jellyfinTrickplay(api, item, source, this.queue.serverId).then((t) => t && !stale() && (this.state.trickplay = t)));
      }
    }
    await Promise.all(tasks.map((t) => t.catch((err) => log.debug(`playback extras: ${String(err)}`))));
    if (!stale()) this.publish(true);
    // What the server lacks, from the third parties turned on (off by default): per kind the server wins, then
    // TheIntroDB, IntroDB, then AniSkip (asked while intro, credits or recap is missing; it fills only those).
    const m = this.state.markers;
    const p = this.deps.settings.value.playback;
    if (api && userId && !caps(api.kind).localUserData && !stale()) {
      const quiet = (what: string) => (err: unknown) => (log.debug(`${what}: ${String(err)}`), null);
      // Asked side by side, each answer applied as it lands (a slow service must not delay the other's intro).
      let c: MediaMarkers | null = null;
      let a: MediaMarkers | null = null;
      const land = () => {
        const merged = (c || a) && mergeMarkers(m, c, a);
        if (merged && !stale()) {
          this.state.markers = merged;
          this.publish(true);
        }
      };
      await Promise.all([
        p.communitySegments && missingKinds(m) && communityFallback(api, userId, item, this.state.durationMs).catch(quiet('community segments')).then((r) => ((c = r), land())),
        p.aniskip && (m?.introEndMs === undefined || m?.creditsStartMs === undefined || !m?.segments?.some((s) => s.type === 'recap')) && aniskipFallback(api, userId, item, this.state.durationMs).catch(quiet('aniskip')).then((r) => ((a = r), land())),
      ]);
    }
  }


  // A Plex Pass gate met during playback, explained once per server and run (never worked around).
  private readonly passExplained = new Set<string>();
  private explainPass(key: string): void {
    const sid = this.queue.serverId ?? '';
    if (this.passExplained.has(`${sid} ${key}`) || !this.state.active) return;
    this.passExplained.add(`${sid} ${key}`);
    this.state.notice = { key, at: Date.now() };
  }

  // The Up Next of the queue after a play of file `file`: the episodes that same file holds (s02e17-e18, one Media
  // and Part on Plex) played with it, so they leave the queue (plex-spec §6.3, #1500).
  // shortcut: decided when the extras load; an end before that (a file under a few seconds) still advances to them.
  private async upNextAfter(file: string | undefined, online: boolean, stale: () => boolean): Promise<UpNext | null> {
    for (;;) {
      const id = this.queue.nextId;
      if (!id) return null;
      const n = await this.fetchUpNext(id, online, file);
      if (n !== 'same') return n;
      if (stale() || this.queue.nextId !== id) return null;
      this.queue.ids.splice(this.queue.index + 1, 1);
      this.state.queueLength = this.queue.ids.length;
    }
  }

  // 'same': item `id` plays the file `file` too.
  private async fetchUpNext(id: string, online: boolean, file?: string): Promise<UpNext | 'same' | null> {
    const item = online
      ? await userItem<BaseItem>(this.deps.connection.apiFor(this.queue.serverId), this.deps.connection.userIdFor(this.queue.serverId), id)
      : this.deps.downloads.findDone(id, this.queue.serverId)?.item;
    if (!item) return null;
    if (file && item.MediaSources?.some((s) => s.Id === file)) return 'same';
    return {
      id,
      name: item.Name,
      seriesName: item.SeriesName,
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
      // Episode stills are 16:9 Primary images; the series poster would not fit the card.
      imageItemId: item.ImageTags?.Primary ? item.Id : undefined,
      imageTag: item.ImageTags?.Primary,
      countdownMs: this.upNextMs(),
      auto: false,
      leftMs: this.upNextMs(),
    };
  }

  // Every time update: intro auto-skip, the up-next trigger, and the countdown following pause.
  private onTick(pausedChanged: boolean): void {
    // A trailer just runs to its end, then the film starts (onEnded). Music has no up-next card.
    if (this.current?.trailer || this.music.active) return;
    const s = this.state;
    const m = s.markers;
    const pos = s.positionMs;
    if (
      s.skipMode === 'auto' &&
      !this.introSkipped &&
      !s.paused &&
      m?.introStartMs !== undefined &&
      m.introEndMs !== undefined &&
      pos >= m.introStartMs &&
      pos < m.introEndMs - 2000
    ) {
      this.introSkipped = true;
      s.notice = { key: 'player.notice.introSkipped', at: Date.now() };
      this.seekTo(m.introEndMs);
      return;
    }
    const playback = this.deps.settings.value.playback;
    const seg = s.paused ? undefined : activeSegment(m, pos, (g) => playback[SEGMENT_SETTING[g.type]] === 'auto' && !this.segmentsSkipped.has(g.startMs));
    if (seg) {
      this.segmentsSkipped.add(seg.startMs);
      s.notice = { key: 'player.notice.segmentSkipped', params: { type: seg.type }, at: Date.now() };
      this.seekTo(seg.endMs);
      return;
    }
    // "Passer le générique" set to Auto: leave at CreditsStart (next item, or the end).
    if (s.creditsSkipMode === 'auto' && !this.creditsSkipped && !s.paused && m?.creditsStartMs !== undefined && pos >= m.creditsStartMs && s.durationMs - pos > 5000 && this.current) {
      this.creditsSkipped = true;
      // Same path as the real end: next item (with the "Toujours là ?" guard) or stop.
      void this.onEnded();
      return;
    }
    const u = s.upNext;
    if (u && pausedChanged && u.auto && !u.stillWatching) {
      if (s.paused) this.freezeCountdown();
      else this.runCountdown(u.leftMs);
    }
    const trigger = m?.creditsStartMs ?? (s.durationMs > 60_000 ? s.durationMs - UP_NEXT_FALLBACK_MS : undefined);
    if (!this.queue.hasNext || trigger === undefined || !this.current) return;
    if (pos >= trigger && !u && !this.upNextDismissed) this.showUpNext();
    else if (u && !u.stillWatching && pos < trigger - 1000) {
      // Seeked back out of the credits.
      this.clearUpNext();
      this.publish(true);
    }
  }

  private upNextMs(): number {
    return this.deps.settings.value.playback.upNextSeconds * 1000;
  }

  private stillWatchingDue(): boolean {
    // mpv's own window (native Wayland) has no OSD to ask in, and its keys never reach lastInputAt.
    if (this.player instanceof MpvPlayer && this.player.detached) return false;
    return this.autoAdvanced >= STILL_WATCHING_EPISODES || Date.now() - this.lastInputAt >= STILL_WATCHING_IDLE_MS;
  }

  private showUpNext(): void {
    // "End of this video" takes priority over autoplay.
    const auto = this.deps.settings.value.playback.autoPlayNext && this.state.sleep?.minutes !== 'eov';
    const id = this.queue.nextId;
    const base = this.nextInfo?.id === id ? this.nextInfo : { id, name: '' };
    const still = auto && this.stillWatchingDue();
    const countdown = this.upNextMs();
    this.state.upNext = { ...base, countdownMs: countdown, leftMs: countdown, auto, stillWatching: still || undefined };
    if (still) {
      // Nobody may be watching: stop where we are and let the display sleep.
      this.player?.pause();
      this.releasePower();
    } else if (auto && !this.state.paused) {
      this.runCountdown(countdown);
    }
    this.publish(true);
  }

  private runCountdown(ms: number): void {
    const u = this.state.upNext;
    if (!u) return;
    if (this.upNextTimer) clearTimeout(this.upNextTimer);
    u.leftMs = ms;
    u.deadline = Date.now() + ms;
    this.upNextTimer = setTimeout(() => {
      this.upNextTimer = null;
      void this.advance(true);
    }, ms);
  }

  private freezeCountdown(): void {
    if (this.upNextTimer) clearTimeout(this.upNextTimer);
    this.upNextTimer = null;
    const u = this.state.upNext;
    if (u?.deadline) {
      u.leftMs = Math.max(0, u.deadline - Date.now());
      u.deadline = undefined;
    }
  }

  private clearUpNext(): void {
    if (this.upNextTimer) clearTimeout(this.upNextTimer);
    this.upNextTimer = null;
    this.state.upNext = undefined;
  }

  private async advance(auto: boolean): Promise<void> {
    if (!this.queue.hasNext) return this.stop();
    if (this.divert?.command({ type: 'next' })) return;
    const kind = this.current?.kind ?? this.player?.kind;
    this.clearUpNext();
    await this.reports.stopped();
    this.queue.index++;
    if (auto) this.autoAdvanced++;
    const deferred = this.queue.takeDeferred();
    await this.startItem({ ...deferred, player: kind }).catch((err) => this.fail(err));
  }

  private async onEnded(): Promise<void> {
    this.state.positionMs = this.state.durationMs;
    const trailer = this.current?.trailer;
    await this.reports.stopped();
    if (this.music.active) return this.music.onEnded();
    const hasNext = this.queue.hasNext;
    if (trailer && hasNext) {
      await this.advance(false);
    } else if (this.state.sleep?.minutes === 'eov' && !this.state.sleep.promptUntil) {
      // Sleep timer "end of this video": stay at the end and ask; Continue goes on (command 'sleep').
      this.sleep.atEnd = true;
      this.clearUpNext();
      this.sleep.fire();
    } else if (this.state.upNext?.stillWatching) {
      // Keep the idle player and the question on screen until someone answers.
      this.publish(true);
    } else if (this.deps.settings.value.playback.autoPlayNext && hasNext && !this.upNextDismissed) {
      if (this.stillWatchingDue()) this.showUpNext();
      else await this.advance(true);
    } else {
      await this.stop();
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error('playback failed', err);
    this.deps.onMessage('error', message);
    void this.stop();
  }

  // animate: a real exit plays the player's exit transition first (not on quit, nor once its window is gone).
  async stop(animate = true): Promise<void> {
    // A second stop (X clicked twice) waits for the transition instead of cutting it short.
    if (this.exiting) await this.exiting;
    this.loadSeq++;
    this.recovery.reset();
    this.zap.stop();
    this.lives.cancel();
    // The report takes its figures now but must not hold up the local cleanup (quit has a 4 s budget);
    // the channel a make-before-break zap was leaving goes after it, as it did before.
    const serverId = this.state.item?.serverId;
    const report = this.reports.stopped()
      // Pages reload the position once the server has it, without waiting for a socket UserDataChanged that
      // may come before the save, late or never (#14: resuming again in the same session used the old one).
      .then(() => serverId && this.deps.windows.broadcast(Channels.serverEvent, { type: 'UserDataChanged', serverId }))
      .then(() => this.lives.releasePrev())
      .catch((err) => log.warn('report stopped failed', err));
    this.clearTimers();
    this.clearUpNext();
    this.sleep.set(null, false);
    this.releasePower();
    const player = this.player;
    this.player = null;
    this.unwatchMinimize?.();
    if (player && animate && this.state.active) await (this.exiting = this.leave(player).finally(() => (this.exiting = null)));
    if (player) {
      clearThumbar(player.hostWindow);
      await player.destroy().catch((err) => log.warn('player destroy failed', err));
      this.lives.clearCache();
    }
    await this.deps.display.restoreIfChanged();
    await this.deps.hdr.restore();
    this.state = idle(this.state.volume, this.state.muted);
    this.publish(true);
    await report;
  }

  // Paused at once (no audio tail), then the player fades out over the page it was opened from.
  private async leave(player: ActivePlayer): Promise<void> {
    player.pause();
    await player
      .leave(this.deps.windows.reducedMotion(), (phase) => {
        this.state.exiting = phase;
        this.publish(true);
      })
      .catch((err) => log.warn('exit transition failed', err));
  }

  // part: the same viewing of a multi-part Plex film goes on in another part (D-4), under the same session.
  private async restart(overrides: { audio?: number; subtitle?: number | null; player?: 'html'; part?: boolean }): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const position = this.state.positionMs;
    await this.reports.stopped(cur, false, overrides.part);
    const subtitle = overrides.subtitle !== undefined ? overrides.subtitle : cur.subtitleIndex;
    await this.startItem({
      startMs: position,
      mediaSourceId: cur.source?.Id,
      audioStreamIndex: overrides.audio ?? cur.audioIndex ?? undefined,
      subtitleStreamIndex: subtitle === null ? -1 : subtitle,
      player: overrides.player ?? cur.kind,
      playSessionId: overrides.part ? cur.playSessionId : undefined,
    }).catch((err) => this.fail(err));
  }

  // X-02 sheet data: the versions (2 or more) and the Quality rows of the source being played.
  private qualityState(item: BaseItem, source?: MediaSource): Pick<PlaybackState, 'qualityOptions' | 'currentQuality'> {
    const sources = item.MediaSources ?? [];
    // The item's own entry: PlaybackInfo's copy can describe the transcode instead of the file.
    const orig = sources.find((s) => s.Id === source?.Id) ?? source;
    const rows = qualityRows({ bitrate: orig?.Bitrate, height: heightClass(videoOf(orig)?.Width, videoOf(orig)?.Height), size: orig?.Size, durationMs: (item.RunTimeTicks ?? 0) / TICKS_PER_MS });
    const cap = this.qualityCap;
    const labels = sourceLabels(sources);
    return {
      qualityOptions: { versions: sources.length > 1 ? sources.map((s, i) => ({ id: s.Id, label: labels[i], size: s.Size })) : [], rows },
      currentQuality: { mediaSourceId: source?.Id, maxBitrate: cap === undefined || cap >= ORIGINAL_BITRATE ? null : cap },
    };
  }

  // X-02: another bitrate cap (null = Original) or version, reloaded in place at the current position
  // with the same tracks. The old stream plays on until the new PlaybackInfo resolves; a failure up to
  // there leaves it playing and raises a notice.
  private async switchQuality(maxBitrate: number | null, mediaSourceId?: string): Promise<void> {
    const cur = this.current;
    if (!cur || cur.offline || cur.trailer || this.switching || this.state.currentQuality?.switching) return;
    if (maxBitrate !== null && !(typeof maxBitrate === 'number' && Number.isFinite(maxBitrate) && maxBitrate > 0)) return;
    const prevCap = this.qualityCap;
    const cap = maxBitrate === null ? ORIGINAL_BITRATE : Math.min(ORIGINAL_BITRATE, Math.round(maxBitrate));
    // The OSD names the preset from these (QualitySheet.svelte); 0 = Original.
    const done = { key: 'player.quality.switched', params: { bitrate: maxBitrate === null ? 0 : cap } };
    this.qualityCap = cap;
    if (cur.live) {
      // A re-tune of the same channel: make-before-break, and a failed tune restores the old one
      // (restorePrev puts `cur` back as current), so only a new adopted stream counts as switched.
      this.state.currentQuality = { maxBitrate: maxBitrate === null ? null : cap, switching: true };
      this.publish(true);
      // A preset skips direct play (the server would ignore the cap); Original goes back to it.
      await this.tuneChannel(cur.item.Id, { rung: maxBitrate === null ? 0 : 1, steps: 0 });
      const ok = this.current !== cur && Boolean(this.current?.live?.adopted);
      if (!ok) this.qualityCap = prevCap;
      const kept = this.qualityCap;
      this.state.currentQuality = { maxBitrate: kept === undefined || kept >= ORIGINAL_BITRATE ? null : kept };
      if (this.state.active) this.state.notice = ok ? { ...done, at: Date.now() } : { key: 'player.quality.failed', at: Date.now() };
      this.publish(true);
      return;
    }
    const target = cur.item.MediaSources?.find((s) => s.Id === (mediaSourceId ?? cur.source?.Id)) ?? cur.source;
    // MediaSourceId is never sent empty: Jellyfin would pick another version.
    if (!target?.Id) {
      this.qualityCap = prevCap;
      return;
    }
    const sameSource = target.Id === cur.source?.Id;
    const from = cur.source?.MediaStreams ?? cur.item.MediaStreams ?? [];
    const to = target.MediaStreams ?? from;
    let stopped = false;
    this.switching = true;
    if (this.state.currentQuality) this.state.currentQuality.switching = true;
    this.publish(true);
    try {
      await this.startItem({
        startMs: this.state.positionMs,
        mediaSourceId: target.Id,
        audioStreamIndex: sameSource ? (cur.audioIndex ?? undefined) : sameTrack(from, to, cur.audioIndex),
        subtitleStreamIndex: cur.subtitleIndex === null ? -1 : sameSource ? cur.subtitleIndex : sameTrack(from, to, cur.subtitleIndex),
        player: cur.kind,
        beforeLoad: async () => {
          stopped = true;
          await this.reports.stopped(cur, true);
        },
      });
      if (!stopped || !this.state.active) return; // superseded by another start or a stop
      const seriesId = cur.item.SeriesId;
      if (!sameSource && seriesId) {
        this.memory.rememberVersion(seriesId, sourceSignature(target));
      }
      const sources = cur.item.MediaSources ?? [];
      const label = sourceLabels(sources)[sources.indexOf(target)] ?? sourceLabel(target);
      this.state.notice = sameSource ? { ...done, at: Date.now() } : { key: 'player.quality.versionSwitched', params: { label }, at: Date.now() };
      this.publish(true);
    } catch (err) {
      if (stopped) return this.fail(err);
      this.qualityCap = prevCap;
      log.warn('quality switch failed', err);
      if (this.state.currentQuality) this.state.currentQuality.switching = false;
      this.state.notice = { key: 'player.quality.failed', at: Date.now() };
      this.publish(true);
    } finally {
      this.switching = false;
    }
  }

  // X-03: after a subtitle download, PlaybackInfo again (the server may still be saving the file: up to
  // 5 tries over about 3 s) and select the new external stream. mpv direct play sub-adds it in place;
  // the <video> player and a transcode (burn-in) restart at the current position via the 'subtitle' path.
  private async refreshSubtitles(): Promise<void> {
    const cur = this.current;
    const sourceId = cur?.source?.Id;
    if (!cur || !sourceId || cur.offline || cur.live || cur.trailer) return;
    const api = this.deps.connection.apiFor(cur.serverId);
    const before = cur.source?.MediaStreams ?? [];
    let streams: MediaStream[] = [];
    let added: MediaStream | null = null;
    for (let i = 0; i < 5 && !added; i++) {
      if (i) await new Promise((r) => setTimeout(r, 800));
      if (this.current !== cur) return;
      const info = await api
        .post<PlaybackInfoResponse>(
          `/Items/${cur.item.Id}/PlaybackInfo`,
          { UserId: cur.userId, MediaSourceId: sourceId, StartTimeTicks: Math.round(this.state.positionMs * TICKS_PER_MS), IsPlayback: false },
          { DeviceProfile: buildDeviceProfile(cur.kind, this.qualityCap ?? ORIGINAL_BITRATE, api.kind), UserId: cur.userId, MediaSourceId: sourceId, IsPlayback: false, AutoOpenLiveStream: false },
        )
        .catch((err) => (log.warn('subtitle refresh failed', err), null));
      streams = info?.MediaSources?.find((s) => s.Id === sourceId)?.MediaStreams ?? [];
      added = addedSubtitle(before, streams);
    }
    if (this.current !== cur || !this.state.active) return;
    if (!added) {
      this.state.notice = { key: 'player.subSearch.failed', at: Date.now() };
      this.publish(true);
      return;
    }
    cur.source = { ...cur.source!, MediaStreams: streams };
    this.state.subtitleTracks = streams.filter((s) => s.Type === 'Subtitle').map(toTrack);
    const url = added.DeliveryUrl && isServerOrigin(api, added.DeliveryUrl) ? subtitleUrl(api, cur.kind, added.DeliveryUrl, cur.serverId) : null;
    if (cur.kind === 'mpv' && url) cur.external?.push({ index: added.Index, url, label: trackLabel(added), language: added.Language });
    // Selected like a pick in the track sheet, so X-05's memory keeps it for the series.
    await this.command({ type: 'subtitle', index: added.Index });
    if (this.state.active) this.state.notice = { key: 'player.subSearch.added', at: Date.now() };
    this.publish(true);
  }

  private seekTo(target: number): void {
    const p = this.player;
    if (!p) return;
    // Live: only inside the timeshift window (livetv/live-player.ts); no seek without one.
    const live = this.current?.live ? this.lives.clampSeek(target) : undefined;
    if (live === null) return;
    const max = this.state.durationMs > 0 ? this.state.durationMs - 1000 : target;
    const clamped = live ?? Math.max(0, Math.min(max, target));
    // Before the start of a Plex transcode begun at the resume point: a new one from there (PMS has no segment).
    const base = this.current?.baseMs ?? 0;
    // Or past the end of the part of a multi-part film that plays: the part there.
    const end = this.current?.partEndMs;
    if ((base && clamped < base) || (end && clamped >= end)) {
      this.state.positionMs = clamped;
      void this.restart({ part: true });
      return;
    }
    p.seek(clamped - base);
    this.state.positionMs = clamped;
    this.publish(true);
    this.reports.progress('TimeUpdate');
  }

  async command(cmd: PlaybackCommand): Promise<void> {
    // Réglages, with or without a player.
    if (cmd.type === 'forget-player-settings') return this.memory.forget();
    if (cmd.type === 'reconnect-retry') return this.recovery.retry();
    const p = this.player;
    if (!p || !this.state.active) return;
    if (this.divert?.command(cmd)) return;
    this.lastInputAt = Date.now();
    this.autoAdvanced = 0;
    // Live mode: next / previous (SMTC, media keys, thumbar, remote) change channel.
    if (this.current?.live && (cmd.type === 'next' || cmd.type === 'previous')) cmd = { type: 'zap', delta: cmd.type === 'next' ? 1 : -1 };
    if (this.lives.command(cmd)) return;
    if (await this.music.command(cmd)) return;
    const u = this.state.upNext;
    if (u?.stillWatching && this.current && (cmd.type === 'toggle-pause' || cmd.type === 'resume')) {
      // Resuming answers "Toujours là ?": back to a normal card (its countdown restarts on unpause).
      u.stillWatching = undefined;
      u.leftMs = u.countdownMs;
    }
    switch (cmd.type) {
      case 'toggle-pause':
        if (this.state.paused) p.play();
        else p.pause();
        break;
      case 'pause':
        p.pause();
        break;
      case 'resume':
        p.play();
        break;
      case 'seek':
      case 'seek-relative':
        this.seekTo(cmd.type === 'seek' ? cmd.positionMs : this.state.positionMs + cmd.deltaMs);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'next':
        if (this.queue.hasNext) await this.advance(false);
        break;
      case 'previous':
        if (this.state.positionMs > 5000 || this.queue.index === 0) {
          if (this.current?.baseMs) this.seekTo(0);
          else p.seek(0);
        } else {
          const kind = this.current?.kind ?? p.kind;
          this.clearUpNext();
          await this.reports.stopped();
          this.queue.index--;
          await this.startItem({ player: kind }).catch((err) => this.fail(err));
        }
        break;
      case 'skip': {
        const end = this.state.markers?.introEndMs;
        if (cmd.segment === 'intro' && end !== undefined) this.seekTo(end);
        // Credits with nothing queued after: the item is over.
        else if (cmd.segment === 'credits' && this.current) await this.onEnded();
        else {
          const seg = activeSegment(this.state.markers, this.state.positionMs, (g) => g.type === cmd.segment);
          if (seg) this.seekTo(seg.endMs);
        }
        break;
      }
      case 'zap':
        if (this.current?.live) this.zap.press(cmd.delta === -1 ? -1 : 1);
        break;
      case 'tune':
        if (this.current?.live) this.zap.tune(cmd.channelId);
        break;
      case 'last-channel':
        if (this.current?.live) this.zap.last();
        break;
      case 'live-lens':
        this.zap.setLens(cmd.lens, cmd.lensLabel, cmd.entries);
        break;
      case 'live-edge':
        if (this.current?.live) this.lives.toEdge();
        break;
      case 'guide-overlay':
        if (p instanceof MpvPlayer) await p.setGuideOverlay(cmd.open === true);
        break;
      case 'pip':
        this.deps.windows.togglePlaybackPip();
        this.state.fullscreen = p.isFullscreen();
        this.publish(true);
        break;
      case 'sleep':
        if (this.sleep.atEnd && cmd.minutes !== null) {
          // "Continue" after "end of this video": the timer restarts and the queue goes on.
          this.sleep.set(cmd.minutes);
          if (this.queue.hasNext) await this.advance(false);
          else await this.stop();
        } else {
          this.sleep.set(cmd.minutes);
        }
        break;
      case 'sub-seek':
        if (p instanceof MpvPlayer) p.subSeek(cmd.delta === -1 ? -1 : 1);
        break;
      case 'quality':
        await this.switchQuality(cmd.maxBitrate, typeof cmd.mediaSourceId === 'string' ? cmd.mediaSourceId : undefined);
        break;
      case 'subtitles-refresh':
        await this.refreshSubtitles();
        break;
      case 'up-next-cancel':
        this.upNextDismissed = true;
        this.clearUpNext();
        this.publish(true);
        break;
      case 'volume': {
        // mpv (video or music) can amplify up to 150 % when the boost is on; <video> stops at 100 %.
        const max = p.kind === 'mpv' && this.deps.settings.value.playback.volumeBoost ? 150 : 100;
        p.setVolume(Math.max(0, Math.min(max, cmd.value)));
        this.state.volume = Math.max(0, Math.min(max, cmd.value));
        this.publish();
        break;
      }
      case 'mute':
        p.setMuted(cmd.value);
        this.state.muted = cmd.value;
        this.publish();
        break;
      case 'rate':
        p.setRate(Math.max(0.25, Math.min(4, cmd.value)));
        this.state.rate = cmd.value;
        if (this.current?.item.MediaType === 'Video' && !this.current.live && !cmd.hold) this.remember('speed', Math.max(0.25, Math.min(4, cmd.value)));
        this.publish(true);
        break;
      case 'audio': {
        if (!this.state.audioTracks.some((t) => t.index === cmd.index)) return;
        this.rememberTrack('audio', cmd.index);
        if (await p.setAudio(cmd.index)) {
          this.state.audioIndex = cmd.index;
          if (this.current) this.current.audioIndex = cmd.index;
          this.reports.progress('AudioTrackChange');
          this.publish(true);
        } else {
          await this.restart({ audio: cmd.index });
          // The change itself, as the in-place path reports it (Plex stores it on the part: plex-playback.ts).
          if (this.current?.audioIndex === cmd.index) this.reports.progress('AudioTrackChange');
        }
        break;
      }
      case 'subtitle': {
        const index = cmd.index >= 0 ? cmd.index : null;
        if (index !== null && !this.state.subtitleTracks.some((t) => t.index === index)) return;
        this.rememberTrack('subtitle', index);
        // Turning the primary off, or promoting the secondary to primary, clears the secondary.
        if ((index === null || index === this.state.secondarySubtitleIndex) && p instanceof MpvPlayer && this.state.secondarySubtitleIndex != null) {
          await p.setSecondarySubtitle(null);
          this.state.secondarySubtitleIndex = null;
        }
        if (await p.setSubtitle(index)) {
          this.state.subtitleIndex = index;
          if (this.current) this.current.subtitleIndex = index;
          this.reports.progress('SubtitleTrackChange');
          this.publish(true);
        } else {
          await this.restart({ subtitle: index });
          if (this.current && this.current.subtitleIndex === index) this.reports.progress('SubtitleTrackChange');
        }
        break;
      }
      case 'toggle-fullscreen':
        p.setFullscreen(!p.isFullscreen());
        this.state.fullscreen = p.isFullscreen();
        this.publish(true);
        break;
      case 'aspect': {
        if (!ASPECT_MODES.includes(cmd.mode)) return;
        const zoom = ZOOM_STEPS.includes(cmd.zoom ?? NaN) ? cmd.zoom! : (this.state.aspect?.zoom ?? 1.25);
        const aspect: VideoAspect = { mode: cmd.mode, zoom };
        if (this.current && !this.current.live) this.remember('aspect', aspect);
        p.setAspect(aspect);
        this.state.aspect = aspect;
        this.state.notice =
          aspect.mode === 'zoom'
            ? { key: 'player.aspect.zoomPercent', params: { percent: Math.round(zoom * 100) }, at: Date.now() }
            : { key: `player.aspect.modes.${aspect.mode}`, at: Date.now() };
        this.publish(true);
        break;
      }
      case 'secondary-subtitle': {
        const index = typeof cmd.index === 'number' && cmd.index >= 0 ? cmd.index : null;
        if (!(p instanceof MpvPlayer) || this.current?.live) return;
        // Only beside a primary subtitle, and never the same track.
        const bad = index !== null && (this.state.subtitleIndex === null || index === this.state.subtitleIndex || !this.state.subtitleTracks.some((t) => t.index === index));
        if (bad || !(await p.setSecondarySubtitle(index))) return;
        this.state.secondarySubtitleIndex = index;
        this.publish(true);
        break;
      }
      case 'audio-delay':
      case 'subtitle-delay': {
        const kind = cmd.type === 'audio-delay' ? 'audio' : 'subtitle';
        if (!(p instanceof MpvPlayer)) {
          this.deps.onMessage('info', t('main.playback.delayMpvOnly'));
          break;
        }
        const delta = Math.max(-5000, Math.min(5000, Number(cmd.deltaMs) || 0));
        const ms = await p.adjustDelay(kind, delta).catch(() => null);
        if (ms === null) break;
        this.remember(kind === 'audio' ? 'audioDelay' : 'subtitleDelay', ms);
        // Shown in the OSD: in mpv mode the main window (and its toasts) sits behind the video.
        this.state.notice = { key: 'player.notice.delay', params: { kind, value: `${ms > 0 ? '+' : ''}${ms}` }, at: Date.now() };
        this.publish(true);
        break;
      }
    }
  }

  private remember(prop: ScopedProp, value: unknown): void {
    if (this.current?.trailer) return;
    this.memory.remember(prop, value);
  }

  // A manual pick during an episode becomes the series default, during a film that film's (player-memory.ts).
  private rememberTrack(kind: 'audio' | 'subtitle', index: number | null): void {
    const c = this.current;
    if (this.lives.rememberTrack(c, kind, index) || !c || c.trailer) return;
    this.memory.rememberTrack(c, c.item.SeriesId ?? c.item.Id, kind, index);
  }

  // Cast handoff (cast/cast-manager.ts, cast-spec §2.4): the queue without trailers, the position and tracks.
  castSnapshot(): CastSnapshot | null {
    const c = this.current;
    const sid = this.queue.serverId;
    if (!this.state.active || !c || c.offline || c.trailer || !sid) return null;
    const ids = c.live ? [c.item.Id] : this.queue.ids.filter((id) => !this.queue.trailers.has(id));
    return {
      serverId: sid,
      itemIds: ids,
      startIndex: Math.max(0, ids.indexOf(c.item.Id)),
      positionTicks: Math.round(this.state.positionMs * TICKS_PER_MS),
      msid: c.source?.Id,
      audio: c.audioIndex ?? undefined,
      sub: c.subtitleIndex ?? -1,
      live: Boolean(c.live),
      policy: c.live ? this.lives.session.policy(sid) : 'mbb',
    };
  }

  // A Plex server stopped this client's session of `itemId` (its notifications socket, plex-spec §6.5).
  // A brief OSD readout from outside the player (SyncPlay's "Paused by the group").
  notify(key: string, params?: Record<string, string | number>): void {
    if (!this.state.active) return;
    this.state.notice = { key, params, at: Date.now() };
    this.publish(true);
  }

  serverEnded(serverId: string, itemId: string): Promise<void> {
    return this.reports.serverEnded(serverId, itemId);
  }

  // Remote control from another client (Emby/Jellyfin "Play on" and remote): remote-commands.ts.
  // serverId: the server whose socket carried it; its item ids are only valid there.
  handleRemote(msg: SocketMessage, serverId?: string): boolean {
    return handleRemote(this, this.deps.settings, msg, serverId);
  }

  private clearTimers(): void {
    this.reports.clearTimer();
    this.lives.clearTimers();
  }

  // adoptLive: a tuned channel showed its first frame (livetv/live-player.ts).
  private adoptLive(video: boolean): void {
    this.reports.start();
    this.reports.startTimer();
    this.blockPower(video);
    this.updateThumbar();
    this.state.buffering = false;
    this.publish(true);
  }

  private blockPower(video: boolean): void {
    this.powerVideo = video;
    this.startPower(video ? 'prevent-display-sleep' : 'prevent-app-suspension');
  }

  private startPower(kind: 'prevent-display-sleep' | 'prevent-app-suspension'): void {
    this.releasePower();
    this.powerBlocker = powerSaveBlocker.start(kind);
  }

  // B05: paused (mpv or <video>), the display may sleep; a live pause keeps the app awake for its timeshift.
  // Play takes the blocker back, also after the sleep timer's or "Still watching?" pause.
  private pausePower(paused: boolean): void {
    if (!paused) this.blockPower(this.powerVideo);
    else if (this.current?.live) this.startPower('prevent-app-suspension');
    else this.releasePower();
  }

  private releasePower(): void {
    if (this.powerBlocker !== null && powerSaveBlocker.isStarted(this.powerBlocker)) powerSaveBlocker.stop(this.powerBlocker);
    this.powerBlocker = null;
  }

  private updateThumbar(): void {
    const p = this.player;
    if (!p) return;
    const live = Boolean(this.current?.live);
    setPlaybackThumbar(p.hostWindow, this.state.paused, live || this.queue.index > 0, live || this.queue.hasNext, {
      toggle: () => void this.command({ type: 'toggle-pause' }),
      next: () => void this.command({ type: 'next' }),
      previous: () => void this.command({ type: 'previous' }),
    });
  }


  async shutdown(): Promise<void> {
    // Before stop(): a slow Stopped report may outlast the quit budget.
    this.memory.flush();
    await this.stop(false);
    await this.lives.sweep();
  }
}
