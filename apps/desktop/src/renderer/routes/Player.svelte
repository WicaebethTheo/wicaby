<script lang="ts">
  import type Hls from 'hls.js';
  import { onDestroy, onMount } from 'svelte';
  import type { HtmlPlayerCommand, HtmlPlayerEvent, HtmlPlayerLoad } from '../../shared/contract';
  import Osd from '../components/Osd.svelte';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { installMediaHandlers, setSessionMetadata } from '../lib/media-session.svelte';
  import { back } from '../lib/router.svelte';
  import { htmlPlayer, playback, settings } from '../lib/stores.svelte';

  // <video> host for the built-in player. Main's HtmlPlayer adapter drives it
  // through htmlPlayer commands; this page reports back what the element does.
  let video = $state<HTMLVideoElement>();
  let hls: Hls | null = null;
  let current: HtmlPlayerLoad | null = null;
  let pendingSeekMs = 0;
  let trackUrl: string | null = null;
  let trackEl: HTMLTrackElement | null = null;
  let subSeq = 0;
  let lastTimeEmit = 0;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let hlsRecoveries = 0;
  let offCommand: (() => void) | null = null;
  let bufferedMs = $state(0);

  const emit = (ev: HtmlPlayerEvent) => w.htmlPlayer.emit(ev);

  function emitTime(force = false): void {
    const v = video;
    if (!v) return;
    const now = performance.now();
    if (!force && now - lastTimeEmit < 250) return;
    lastTimeEmit = now;
    bufferedMs = bufferedEnd(v);
    const duration = Number.isFinite(v.duration) ? v.duration * 1000 : 0;
    emit({
      type: 'time',
      positionMs: v.currentTime * 1000,
      durationMs: duration,
      paused: v.paused,
      buffering: v.readyState < 3 && !v.paused,
    });
  }

  // End of the buffered range under the playhead, for the scrubber.
  function bufferedEnd(v: HTMLVideoElement): number {
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i) * 1000;
    return 0;
  }

  function emitStats(): void {
    const v = video;
    if (!v || !v.videoWidth) return;
    const q = v.getVideoPlaybackQuality?.();
    const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined;
    emit({
      type: 'stats',
      stats: {
        resolution: `${v.videoWidth}×${v.videoHeight}`,
        droppedFrames: q?.droppedVideoFrames,
        container: hls ? 'hls' : undefined,
        videoCodec: level?.videoCodec,
        audioCodec: level?.audioCodec,
        bitrateKbps: level?.bitrate ? Math.round(level.bitrate / 1000) : undefined,
      },
    });
  }

  function destroyHls(): void {
    hls?.destroy();
    hls = null;
  }

  function clearTrack(): void {
    subSeq++; // a subtitle fetch still in flight is stale now
    trackEl?.remove();
    trackEl = null;
    if (trackUrl) URL.revokeObjectURL(trackUrl);
    trackUrl = null;
  }

  async function setSubtitle(index: number | null): Promise<void> {
    clearTrack();
    const v = video;
    const sub = index === null ? undefined : current?.subtitles.find((s) => s.index === index);
    if (!v || !sub) return;
    const mine = subSeq;
    try {
      const res = await fetch(sub.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (mine !== subSeq) return;
      trackUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = sub.label;
      if (sub.language) t.srclang = sub.language.slice(0, 3);
      t.src = trackUrl;
      t.default = true;
      v.appendChild(t);
      trackEl = t;
      t.track.mode = 'showing';
      t.addEventListener('load', () => (t.track.mode = 'showing'), { once: true });
    } catch (err) {
      w.app.log('warn', `subtitle load failed: ${String(err)}`);
    }
  }

  function load(l: HtmlPlayerLoad): void {
    const v = video;
    if (!v) return;
    leaving = false;
    destroyHls();
    clearTrack();
    current = l;
    hlsRecoveries = 0;
    v.volume = Math.max(0, Math.min(1, l.volume / 100));
    v.muted = l.muted;
    // "Vitesse par défaut": the load algorithm resets playbackRate to defaultPlaybackRate.
    v.defaultPlaybackRate = v.playbackRate = l.rate ?? 1;
    if (l.isHls) {
      pendingSeekMs = 0;
      void attachHls(v, l);
    } else {
      pendingSeekMs = l.startMs;
      v.src = l.url;
      void v.play().catch(() => undefined);
    }
    void setSubtitle(l.subtitleIndex);
  }

  // hls.js (a third of the renderer) is fetched with the first HLS stream, not at app start.
  async function attachHls(v: HTMLVideoElement, l: HtmlPlayerLoad): Promise<void> {
    let Hls: typeof import('hls.js').default;
    try {
      Hls = (await import('hls.js')).default;
    } catch (err) {
      if (current === l) emit({ type: 'error', message: `Flux HLS illisible (${String(err)})` });
      return;
    }
    // Unloaded or replaced while it loaded.
    if (current !== l) return;
    if (!Hls.isSupported()) {
      pendingSeekMs = l.startMs;
      v.src = l.url;
      void v.play().catch(() => undefined);
      return;
    }
    const h = new Hls({ startPosition: l.startMs / 1000, enableWorker: true, maxBufferLength: 60, backBufferLength: 90 });
    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hlsRecoveries < 3) {
        hlsRecoveries++;
        h.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRecoveries < 3) {
        hlsRecoveries++;
        h.recoverMediaError();
      } else {
        emit({ type: 'error', message: `Flux HLS illisible (${data.details})` });
      }
    });
    h.loadSource(l.url);
    h.attachMedia(v);
    // Only now: a play() before the source is set is undone (paused again) by the load attachMedia starts.
    void v.play().catch(() => undefined);
    hls = h;
  }

  function unload(): void {
    destroyHls();
    clearTrack();
    current = null;
    const v = video;
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  function onCommand(c: HtmlPlayerCommand): void {
    const v = video;
    if (!v) return;
    switch (c.type) {
      case 'play':
        void v.play().catch(() => undefined);
        break;
      case 'pause':
        v.pause();
        break;
      case 'seek':
        v.currentTime = c.positionMs / 1000;
        break;
      case 'volume':
        v.volume = Math.max(0, Math.min(1, c.value / 100));
        break;
      case 'mute':
        v.muted = c.value;
        break;
      case 'rate':
        v.playbackRate = c.value;
        break;
      case 'subtitle':
        void setSubtitle(c.index);
        break;
      case 'unload':
        // Reduced motion skips the fade: hidden with the picture, the page under it shows at once.
        leaving = true;
        unload();
        break;
    }
  }

  function mediaErrorText(err: MediaError | null): string {
    switch (err?.code) {
      case 1:
        return t('player.errors.aborted');
      case 2:
        return t('player.errors.network');
      case 3:
        return t('player.errors.decode');
      case 4:
        return t('player.errors.unsupported');
      default:
        return t('player.errors.generic');
    }
  }

  // Shown on the first frame that plays (the start of the stream keeps the main thread busy: a fade from the
  // mount would be over before it is seen), or after 600 ms with the spinner when the stream is slow.
  let entered = $state(false);
  onMount(() => {
    setTimeout(() => (entered = true), 600);
    offCommand = w.htmlPlayer.onCommand(onCommand);
    statsTimer = setInterval(emitStats, 2000);
    const step = settings.value?.playback.seekShortS ?? 10;
    installMediaHandlers(step, step);
  });

  onDestroy(() => {
    offCommand?.();
    if (statsTimer) clearInterval(statsTimer);
    unload();
  });

  // Load every new stream main hands over, including the one that opened this page.
  let loadedSeq = 0;
  $effect(() => {
    const seq = htmlPlayer.seq;
    const l = htmlPlayer.load;
    if (!video || !l || seq === loadedSeq) return;
    loadedSeq = seq;
    // A track belongs to MusicHost.svelte (music-spec §4.1.2).
    if (!l.audio) load(l);
  });

  // Exit transition (HtmlPlayer.leave): the player fades and shrinks a little over the page kept under it
  // (App.svelte). Kept until the route changes: the idle state arrives before back() lands.
  let leaving = $state(false);
  $effect(() => {
    if (playback.value?.exiting) leaving = true;
  });

  // Leave the page once playback ends.
  let wasActive = false;
  $effect(() => {
    // Music plays without this page: from a video straight to a track, it goes too.
    const active = Boolean(playback.value?.active) && !playback.value?.music;
    if (active) wasActive = true;
    else if (wasActive) {
      wasActive = false;
      back();
    }
  });

  let metaKey = '';
  $effect(() => {
    const item = playback.value?.item;
    // Live (§8.3): title = programme, artist = "{numéro} · {chaîne}", artwork = logo, on each adoption.
    const lv = playback.value?.live;
    const ch = lv?.channel;
    const key = `${item?.id}|${ch?.id ?? ''}|${lv?.now?.id ?? ''}`;
    if (!item || key === metaKey) return;
    metaKey = key;
    const [artId, artTag] = ch ? [ch.logoTag ? ch.id : '', ch.logoTag] : [item.imageItemId, item.imageTag];
    setSessionMetadata(
      {
        title: ch ? lv?.now?.title || ch.name : item.name,
        artist: ch ? [ch.number, ch.name].filter(Boolean).join(' · ') : (item.seriesName ?? (item.year ? String(item.year) : '')),
        album: 'Wicaby',
      },
      artId ? imageUrl(artId, 'Primary', { tag: artTag, maxHeight: 512, server: item.serverId }) : null,
    );
  });

  // Same formats as mpv: letterbox, crop, stretch, zoom (letterbox then scale), 1:1 pixels.
  const FIT = { fit: 'contain', fill: 'cover', stretch: 'fill', zoom: 'contain', original: 'none' } as const;
  const aspect = $derived(playback.value?.aspect ?? { mode: 'fit' as const, zoom: 1 });
</script>

<div class="player on-media" class:in={entered} class:leaving>
  <video
    bind:this={video}
    style:object-fit={FIT[aspect.mode]}
    style:transform={aspect.mode === 'zoom' ? `scale(${aspect.zoom})` : undefined}
    playsinline
    onloadedmetadata={() => {
      if (video && pendingSeekMs > 0) {
        video.currentTime = pendingSeekMs / 1000;
        pendingSeekMs = 0;
      }
      emitTime(true);
    }}
    ontimeupdate={() => emitTime()}
    onprogress={() => video && (bufferedMs = bufferedEnd(video))}
    onplay={() => emitTime(true)}
    onpause={() => emitTime(true)}
    onwaiting={() => emitTime(true)}
    onplaying={() => {
      entered = true;
      emitTime(true);
    }}
    onseeked={() => emitTime(true)}
    ondurationchange={() => emitTime(true)}
    onvolumechange={() => video && emit({ type: 'volume', volume: Math.round(video.volume * 100), muted: video.muted })}
    onended={() => emit({ type: 'ended' })}
    onerror={() => {
      if (current && !hls) emit({ type: 'error', message: mediaErrorText(video?.error ?? null) });
    }}
  ></video>
  <Osd state={playback.value} mode="html" {bufferedMs} />
</div>

<style>
  .player {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 50;
    /* Zoom scales the video past the frame. */
    overflow: hidden;
    /* Opening: the page cross-fades into the playing picture rather than cutting to black. Not quite 0: the
       video layer is set up while nobody sees it, not on the fade's first frames. */
    opacity: 0.01;
  }
  .player.in {
    opacity: 1;
    /* motion-ok: the opening cross-fade is timed with main (html-player.ts) */
    transition: opacity calc(220ms * var(--tempo)) var(--ease-in-out);
  }
  /* 300 ms: EXIT_FADE_MS + EXIT_REVEAL_MS / 2 (main/playback/html-player.ts) less a frame. */
  .player.leaving {
    opacity: 0;
    transform: scale(0.97);
    pointer-events: none;
    /* motion-ok: timed with main, see above */
    transition:
      opacity calc(300ms * var(--tempo)) var(--ease-out),
      transform calc(300ms * var(--tempo)) var(--ease-out);
  }
  .leaving :global(.osd) {
    opacity: 0;
    /* motion-ok: timed with main */
    transition: opacity 120ms var(--ease-out);
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  /* Apple-style captions: bold white type on a soft dark plate. */
  video::cue {
    background: rgb(0 0 0 / 0.42);
    color: #fff;
    font-family: var(--font-sans);
    font-size: clamp(18px, 2.4vw, 38px);
    font-weight: 560;
    letter-spacing: -0.005em;
    line-height: 1.32;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }
</style>
