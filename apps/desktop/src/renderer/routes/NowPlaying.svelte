<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { audioBadge } from '../../shared/music-ui';
  import Icon from '../components/Icon.svelte';
  import LyricsPane from '../components/music/LyricsPane.svelte';
  import QueuePanel from '../components/music/QueuePanel.svelte';
  import SimilarPane from '../components/music/SimilarPane.svelte';
  import SeekBar from '../components/music/SeekBar.svelte';
  import Transport from '../components/music/Transport.svelte';
  import Segmented from '../components/Segmented.svelte';
  import TitleBar from '../components/TitleBar.svelte';
  import { apiFor, itemPath } from '../lib/api';
  import { openCastPicker } from '../lib/cast.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { artColour, fullArtPx, initials, placeholderBg } from '../lib/music-art';
  import { ensureItems, known, musicActive, toggleFavorite } from '../lib/music-ui.svelte';
  import { dur } from '../lib/motion';
  import { back, navigate, router } from '../lib/router.svelte';
  import { playback } from '../lib/stores.svelte';

  // The full-screen player (music-spec §4.3): the album art, scaled down to 64 px then blurred, under a --bg scrim
  // (opaque with "Réduire la transparence"); art, title, links, controls on the left; lyrics or the queue on the
  // right. Escape (the music shortcuts) or ↓ (onKey below) closes it; the art morphs from the bar's
  // (view-transition-name).
  const s = $derived(playback.value);
  const it = $derived(s?.item);
  const track = $derived(it ? known[it.id] : undefined);
  const fav = $derived(Boolean(track?.UserData?.IsFavorite));
  const art = (h: number) => (it?.imageItemId ? imageUrl(it.imageItemId, 'Primary', { tag: it.imageTag, maxHeight: h, server: it.serverId }) : '');
  // Up to 75 % of the window height, from the size buckets the bar's prefetch also asks for (music spec MU-A5).
  const big = $derived(it?.imageItemId ? imageUrl(it.imageItemId, 'Primary', { tag: it.imageTag, px: fullArtPx(), server: it.serverId }) : '');
  // The cover's dominant colour under the blurred art: the art fades in over a colour, not grey (MU-A3).
  let tint = $state<string | null>(null);
  $effect(() => {
    const small = art(64);
    tint = null;
    if (!small) return;
    let live = true;
    void artColour(small).then((c) => live && (tint = c));
    return () => (live = false);
  });
  const artist = $derived(track?.ArtistItems?.[0] ?? track?.AlbumArtists?.[0]);
  const TABS = ['lyrics', 'queue', 'similar'] as const;
  const tab = $derived(TABS.find((x) => x === router.route.query.get('tab')) ?? 'lyrics');
  // Clicking the active tab hides the panel and centres the art (C6); any tab shows it again.
  let panelClosed = $state(false);
  function pickTab(v: (typeof TABS)[number]): void {
    panelClosed = v === tab && !panelClosed;
    if (v !== tab) navigate(`/now-playing?tab=${v}`, { replace: true });
  }
  // Track changes crossfade the art and the background (music spec C6); none under reduced motion.
  const xfade = $derived({ duration: dur('med') });

  // The quality badge (C6): codec, bit depth / sample rate, bitrate, from the track's audio stream.
  let badge = $state('');
  // Keyed on the ids: playback.value (and so `it`) is a new object on every position update.
  const curId = $derived(it?.id);
  const curServer = $derived(it?.serverId);
  $effect(() => {
    const id = curId;
    const sid = curServer;
    badge = '';
    if (!id) return;
    let live = true;
    untrack(() => apiFor(sid).item(id))
      .then((full) => {
        const streams = full.MediaSources?.[0]?.MediaStreams ?? full.MediaStreams ?? [];
        if (live) badge = audioBadge(streams.find((x) => x.Type === 'Audio'), (n) => fmt.number(n));
      })
      .catch(() => undefined);
    return () => (live = false);
  });

  $effect(() => {
    if (it?.id) void ensureItems([it.id], it.serverId);
  });
  // The music stopped (end of the queue, stop from the tray): nothing to show.
  $effect(() => {
    if (playback.value && !musicActive()) back('/home');
  });

  // A link closes the player in place: the page replaces it in history.
  const go = (path: string) => navigate(path, { replace: true });

  // ↓ closes the player (spec §4.3) once no handler took it: the music shortcuts take it with nothing focused
  // (volume), spatial nav when there is a control below. Read after the dispatch, so listener order does not matter.
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' || e.repeat || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    setTimeout(() => !e.defaultPrevented && router.route.name === 'now-playing' && back());
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="np on-media" role="dialog" aria-modal="true" aria-label={t('music.bar.label')} data-now-playing>
  <div class="bg" aria-hidden="true" style:background={tint}>
    {#if art(64)}{#key art(64)}<img src={art(64)} alt="" transition:fade={xfade} />{/key}{/if}
  </div>
  <div class="scrim" aria-hidden="true"></div>
  <TitleBar minimal />
  <button class="btn ghost icon close" title={t('music.bar.close')} aria-label={t('music.bar.close')} onclick={() => back()}><Icon name="chevronDown" size={20} /></button>
  {#if it && s}
    <div class="body" data-panel={panelClosed ? 'closed' : 'open'}>
      <section class="left">
        <div class="art" style:view-transition-name="np-art">
          {#if big}{#key big}<img src={big} alt="" decoding="async" transition:fade={xfade} />{/key}{/if}
          {#if !big}<span class="ph-initials" style:background={placeholderBg(it.album ?? it.name)}>{initials(it.album ?? it.name)}</span>{/if}
        </div>
        <div class="meta">
          <div class="names">
            <h1 class="title-1">{it.name}</h1>
            <p class="callout links">
              {#if artist}<a href={`#${itemPath({ Id: artist.Id, ServerId: it.serverId })}`} onclick={(e) => (e.preventDefault(), go(itemPath({ Id: artist.Id, ServerId: it.serverId })))}>{(it.artists ?? []).join(', ') || it.albumArtist}</a>{:else}{(it.artists ?? []).join(', ')}{/if}
              {#if it.album}
                ·
                {#if it.albumId}<a href={`#${itemPath({ Id: it.albumId, ServerId: it.serverId })}`} onclick={(e) => (e.preventDefault(), go(itemPath({ Id: it.albumId!, ServerId: it.serverId })))}>{it.album}</a>{:else}{it.album}{/if}
              {/if}
            </p>
          </div>
          {#if track}
            <button class="btn ghost icon heart" class:on={fav} aria-pressed={fav} aria-label={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} onclick={() => toggleFavorite(track)}>
              <Icon name="heart" size={20} fill={fav} stroke={fav ? 0 : 1.9} />
            </button>
          {/if}
          <!-- The queue goes to a speaker, a group or a TV (cast-manager: the player's handoff). -->
          <button class="btn ghost icon heart" data-cast aria-haspopup="dialog" title={t('cast.button')} aria-label={t('cast.button')} onclick={() => openCastPicker({ itemId: it.id, serverId: it.serverId })}>
            <Icon name="cast" size={20} />
          </button>
        </div>
        {#if badge}<p class="badge caption mono" data-badge>{badge}</p>{/if}
        <SeekBar positionMs={s.positionMs} durationMs={s.durationMs} />
        <Transport large />
      </section>
      <section class="right">
        <Segmented
          value={tab}
          label={t('music.bar.label')}
          options={[
            { value: 'lyrics', label: t('music.lyrics.title') },
            { value: 'queue', label: t('music.bar.queue') },
            { value: 'similar', label: t('music.similar.title') },
          ]}
          onchange={pickTab}
        />
        <div class="pane-body" hidden={panelClosed}>
          {#if tab === 'lyrics'}<LyricsPane item={it} positionMs={s.positionMs} />{:else if tab === 'similar'}<SimilarPane id={curId!} serverId={curServer} />{:else}<QueuePanel embedded />{/if}
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .np {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    animation: up var(--t-med) var(--ease) both;
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  .np :global(.titlebar) {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 3;
  }
  .bg {
    position: absolute;
    inset: -80px;
  }
  .bg img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(60px) saturate(1.2);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }
  :global(html[data-reduce-transparency]) .scrim {
    background: var(--bg);
  }
  .close {
    position: absolute;
    top: calc(var(--titlebar) + 8px);
    left: 20px;
    z-index: 4;
  }
  .body {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(280px, min(75vh, 50vw, 100vh - 320px)) minmax(0, 1fr);
    gap: clamp(32px, 5vw, 88px);
    padding: calc(var(--titlebar) + 48px) clamp(32px, 6vw, 96px) 40px;
  }
  .left {
    display: grid;
    align-content: center;
    gap: 18px;
    min-width: 0;
  }
  .art {
    width: 100%;
    max-width: min(75vh, 50vw, 100vh - 320px);
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border-radius: var(--r-lg);
    background: var(--fill-2);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    color: var(--label-3);
  }
  .art img,
  .art .ph-initials {
    grid-area: 1 / 1;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .badge {
    margin: -8px 0 0;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .art .ph-initials {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: clamp(64px, 9vw, 160px);
    font-weight: 650;
    letter-spacing: -0.02em;
    color: rgb(255 255 255 / 0.92);
  }
  .meta {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .names {
    flex: 1;
    min-width: 0;
  }
  .names h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .links {
    margin: 4px 0 0;
    color: var(--label-2);
  }
  .links a {
    color: inherit;
    text-decoration: none;
  }
  .links a:hover {
    color: var(--label);
    text-decoration: underline;
  }
  .heart.on {
    color: var(--label);
  }
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
    min-width: 0;
    min-height: 0;
  }
  .pane-body {
    flex: 1;
    width: 100%;
    min-height: 0;
  }
  .body[data-panel='closed'] {
    grid-template-columns: minmax(280px, min(75vh, 50vw, 100vh - 320px));
    justify-content: center;
  }
  .body[data-panel='closed'] .right {
    position: absolute;
    top: calc(var(--titlebar) + 48px);
    right: clamp(32px, 6vw, 96px);
  }
</style>
