<script lang="ts">
  // Music in the main window (music-spec §4.1.2, §4.2): the built-in engine's <audio> element (main's HtmlPlayer
  // drives it with the commands the <video> page gets), and the system media session while a track plays, with
  // its title, artists, album and the album's art. With mpv (no window at all) a silent element keeps the
  // session alive, as the OSD does for video, except in WASAPI exclusive mode (tray.ts takes the keys then).
  import { onDestroy, onMount } from 'svelte';
  import type { HtmlPlayerCommand, HtmlPlayerLoad } from '../../../shared/contract';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { installMediaHandlers, silentWavUrl, trackMetadata } from '../../lib/media-session.svelte';
  import { linux } from '../../lib/platform';
  import { htmlPlayer, playback, settings } from '../../lib/stores.svelte';

  let audio = $state<HTMLAudioElement>();
  let loaded = false;
  let pendingSeekMs = 0;
  let lastEmit = 0;
  let gain: GainNode | null = null;
  let keepAlive: HTMLAudioElement | null = null;
  let silentUrl = '';
  let off: (() => void) | null = null;

  const music = $derived(playback.value?.active && playback.value.music ? playback.value : null);

  function emitTime(force = false): void {
    const a = audio;
    if (!a || !loaded) return;
    const now = performance.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    w.htmlPlayer.emit({ type: 'time', positionMs: a.currentTime * 1000, durationMs: Number.isFinite(a.duration) ? a.duration * 1000 : 0, paused: a.paused, buffering: a.readyState < 3 && !a.paused });
  }

  // The server's gain and the preamp through one GainNode (the element's volume only goes down to 1).
  function setGain(db: number): void {
    if (!audio) return;
    if (!gain) {
      const ctx = new AudioContext();
      gain = ctx.createGain();
      ctx.createMediaElementSource(audio).connect(gain).connect(ctx.destination);
    }
    // Bounded here too: an unbounded gain is clipped noise at full scale, a non-finite one throws.
    gain.gain.value = 10 ** ((Number.isFinite(db) ? Math.max(-30, Math.min(db, 24)) : 0) / 20);
  }

  function load(l: HtmlPlayerLoad): void {
    const a = audio!;
    loaded = true;
    // wicaby-media:// answers with CORS, so Web Audio may read the samples.
    a.crossOrigin = 'anonymous';
    a.src = l.url;
    a.volume = Math.max(0, Math.min(1, l.volume / 100));
    a.muted = l.muted;
    a.playbackRate = 1;
    pendingSeekMs = l.startMs;
    setGain(l.audio?.gainDb ?? 0);
    if (!l.audio?.paused) void a.play().catch(() => undefined);
  }

  function unload(): void {
    if (!audio || !loaded) return;
    loaded = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  // Each stream main hands over: an audio one plays here, a video one belongs to the player page.
  let seen = 0;
  $effect(() => {
    const seq = htmlPlayer.seq;
    const l = htmlPlayer.load;
    if (!audio || !l || seq === seen) return;
    seen = seq;
    if (l.audio) load(l);
    else unload();
  });

  function onCommand(c: HtmlPlayerCommand): void {
    const a = audio;
    if (!a || !loaded) return;
    if (c.type === 'play') void a.play().catch(() => undefined);
    else if (c.type === 'pause') a.pause();
    else if (c.type === 'seek') a.currentTime = c.positionMs / 1000;
    else if (c.type === 'volume') a.volume = Math.max(0, Math.min(1, c.value / 100));
    else if (c.type === 'mute') a.muted = c.value;
    else if (c.type === 'rate') a.playbackRate = c.value;
    else if (c.type === 'unload') unload();
  }

  onMount(() => {
    off = w.htmlPlayer.onCommand(onCommand);
  });

  onDestroy(() => {
    off?.();
    unload();
    keepAlive?.pause();
    if (silentUrl) URL.revokeObjectURL(silentUrl);
  });

  // The session: handlers once a track plays, metadata per track, state and position on every update.
  let handlers = false;
  let metaKey = '';
  $effect(() => {
    const s = music;
    if (!s?.item) {
      if (metaKey) {
        metaKey = '';
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
      return;
    }
    if (!handlers) {
      handlers = true;
      const step = settings.value?.playback.seekShortS ?? 10;
      installMediaHandlers(step, step);
    }
    const key = `${s.item.id}|${s.item.imageTag ?? ''}`;
    if (key !== metaKey) {
      metaKey = key;
      trackMetadata(s.item);
    }
    navigator.mediaSession.playbackState = s.paused ? 'paused' : 'playing';
    if (s.durationMs > 0) {
      try {
        navigator.mediaSession.setPositionState({ duration: s.durationMs / 1000, position: Math.min(s.durationMs, Math.max(0, s.positionMs)) / 1000, playbackRate: s.rate || 1 });
      } catch {
        // A stale duration for a moment between tracks.
      }
    }
  });

  // mpv: the silent keep-alive (Linux keeps it in exclusive mode too: MPRIS is the only path there).
  $effect(() => {
    const s = music;
    const exclusive = !linux && Boolean(settings.value?.playback.audioExclusive);
    if (!s || s.player !== 'mpv' || exclusive) {
      keepAlive?.pause();
      return;
    }
    if (!keepAlive) {
      silentUrl = silentWavUrl();
      keepAlive = new Audio(silentUrl);
      keepAlive.loop = true;
    }
    if (s.paused) keepAlive.pause();
    else void keepAlive.play().catch(() => undefined);
  });
</script>

<audio
  bind:this={audio}
  hidden
  onloadedmetadata={() => {
    if (audio && pendingSeekMs > 0) audio.currentTime = pendingSeekMs / 1000;
    pendingSeekMs = 0;
    emitTime(true);
  }}
  ontimeupdate={() => emitTime()}
  onplay={() => emitTime(true)}
  onpause={() => emitTime(true)}
  onwaiting={() => emitTime(true)}
  onplaying={() => emitTime(true)}
  onvolumechange={() => audio && loaded && w.htmlPlayer.emit({ type: 'volume', volume: Math.round(audio.volume * 100), muted: audio.muted })}
  onended={() => loaded && w.htmlPlayer.emit({ type: 'ended' })}
  onerror={() => loaded && w.htmlPlayer.emit({ type: 'error', message: audio?.error?.code === 4 ? t('player.errors.unsupported') : t('player.errors.network') })}
></audio>
