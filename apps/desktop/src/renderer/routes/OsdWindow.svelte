<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PlaybackState } from '../../shared/contract';
  import Osd from '../components/Osd.svelte';
  import { w } from '../lib/bridge';
  import { locale, t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { installMediaHandlers, setSessionMetadata, silentWavUrl } from '../lib/media-session.svelte';
  import { linux } from '../lib/platform';
  import { settings } from '../lib/stores.svelte';

  // Root of the transparent window that floats above mpv's video window. With ?video=1 (Linux texture mode,
  // createPlaybackWindow) it is one opaque window instead: libmpv's frames are drawn by the preload onto
  // #wicaby-video, under the veil and the controls.
  const video = new URLSearchParams(location.search).get('video') === '1';
  if (video) document.documentElement.classList.add('video');
  let pbState = $state<PlaybackState | null>(null);
  let audio: HTMLAudioElement | null = null;
  let silentUrl: string | null = null;
  let off: (() => void) | null = null;

  // The veil over mpv's picture. Opening: main calls __wicabyVeil once it showed this window
  // (window-manager.ts createPlaybackWindows) and brings mpv's window in, and hides its own, when it resolves
  // (veil opaque); the veil lifts on the first frame after that. Exit (MpvPlayer.leave): up on 'out', down on
  // 'reveal'. Never with reduced motion.
  let opening = $state(true);
  let shown = $state(false);
  let held = $state(true);
  let veilUp: (() => void) | null = null;
  $effect(() => {
    if (!held && pbState?.active && !pbState.buffering) opening = false;
  });
  const veil = $derived(pbState?.exiting ? pbState.exiting === 'out' : opening && shown);
  (window as { __wicabyVeil?: () => Promise<void> }).__wicabyVeil = () =>
    new Promise<void>((resolve) => {
      veilUp = () => {
        veilUp = null;
        resolve();
        setTimeout(() => (held = false), 50);
      };
      requestAnimationFrame(() => (shown = true));
      setTimeout(() => veilUp?.(), 600);
    });

  onMount(() => {
    off = w.playback.onState((s) => {
      pbState = s;
    });
    void w.playback.getState().then((s) => (pbState ??= s));
    installMediaHandlers();
  });

  onDestroy(() => {
    off?.();
    audio?.pause();
    audio = null;
    if (silentUrl) URL.revokeObjectURL(silentUrl);
  });

  // Silent keep-alive element. Skipped with WASAPI exclusive mode, where a
  // second shared stream on the device would fight mpv for the endpoint. Linux keeps it:
  // it is the only path for MPRIS and media keys there (needsGlobalMediaKeys, tray.ts).
  $effect(() => {
    const active = Boolean(pbState?.active);
    const paused = Boolean(pbState?.paused);
    const exclusive = !linux && Boolean(settings.value?.playback.audioExclusive);
    if (!active || exclusive) {
      audio?.pause();
      return;
    }
    if (!audio) {
      silentUrl = silentWavUrl();
      audio = new Audio(silentUrl);
      audio.loop = true;
    }
    if (paused) audio.pause();
    else void audio.play().catch(() => undefined);
  });

  // Metadata shown in the Windows media flyout.
  let metaKey = '';
  $effect(() => {
    const item = pbState?.item;
    if (!item) return;
    // Live (§8.3): title = programme, artist = "{numéro} · {chaîne}", artwork = logo, on each adoption.
    const lv = pbState?.live;
    const ch = lv?.channel;
    const key = `${item.id}|${locale.current}|${ch?.id ?? ''}|${lv?.now?.id ?? ''}`;
    if (key === metaKey) return;
    metaKey = key;
    const [artId, artTag] = ch ? [ch.logoTag ? ch.id : '', ch.logoTag] : [item.imageItemId, item.imageTag];
    setSessionMetadata(
      {
        title: ch ? lv?.now?.title || ch.name : item.name,
        artist: ch ? [ch.number, ch.name].filter(Boolean).join(' · ') : (item.seriesName ?? (item.year ? String(item.year) : '')),
        album: item.seriesName && item.seasonNumber !== undefined ? t('player.session.season', { season: item.seasonNumber }) : 'Wicaby',
      },
      artId ? imageUrl(artId, 'Primary', { tag: artTag, maxHeight: 512, server: item.serverId }) : null,
    );
  });

  $effect(() => {
    const s = pbState;
    if (!s?.active) {
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.playbackState = s.paused ? 'paused' : 'playing';
    if (s.durationMs > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: s.durationMs / 1000,
          position: Math.min(s.durationMs, Math.max(0, s.positionMs)) / 1000,
          playbackRate: s.rate || 1,
        });
      } catch {
        // Invalid intermediate state (position beyond a stale duration).
      }
    }
  });
</script>

<!-- The veil sits under the controls: the loader stays visible while the picture is still black. -->
<div class="osd-root on-media" class:leaving={pbState?.exiting}>
  {#if video}<canvas id="wicaby-video" aria-hidden="true"></canvas>{/if}
  <div class="veil" class:on={veil} aria-hidden="true" ontransitionend={() => veil && veilUp?.()}></div>
  <Osd state={pbState} mode="mpv" />
</div>

<style>
  .osd-root {
    position: fixed;
    inset: 0;
    background: transparent;
    overflow: hidden;
  }
  /* The picture is left to the veil, as mpv's own window is in the two-window mode. */
  .leaving > :global(:not(.veil, #wicaby-video)) {
    opacity: 0;
    pointer-events: none;
    /* motion-ok: the exit is timed with main (EXIT_FADE_MS, EXIT_REVEAL_MS) */
    transition: opacity 120ms var(--ease-out);
  }
  /* The backing store has the frame's own size (preload); scaled to the window here, never stretched. */
  #wicaby-video {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    pointer-events: none;
  }
  /* Durations match EXIT_FADE_MS and EXIT_REVEAL_MS (main/playback/player.ts). */
  .veil {
    position: fixed;
    inset: 0;
    background: #000;
    opacity: 0;
    pointer-events: none;
    /* motion-ok: timed with main */
    transition: opacity 200ms var(--ease-out);
  }
  /* Even all the way to black, so it holds black for a frame or two, not half the time. */
  .veil.on {
    opacity: 1;
    /* motion-ok: timed with main */
    transition: opacity 220ms var(--ease-in-out);
  }
</style>
