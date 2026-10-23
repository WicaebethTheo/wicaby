<script lang="ts">
  // A title's menu (lib/item-menu.svelte.ts), as Emby's long press offers it, in a Wicaby sheet: the artwork and the
  // title on top, then
  // - play: resume (or play), from the start, shuffle (a series, a season, a collection);
  // - go: its page, its series;
  // - mark watched or not (an episode's previous ones too), favourite, remove from Continue watching (with an undo),
  //   download, add to a playlist or a collection;
  // - Emby's media info (the file, its streams, the external links), copy the stream URL, share;
  // - for an administrator, the desktop's tools (edit the metadata, identify, artwork, refresh, subtitles, split
  //   versions); delete when the server's CanDelete allows it for this user.
  // The title is read while the press is held (lib/item-menu fetchMenuItem: watched state, favourite, CanDelete as of
  // now), so the sheet opens with its final rows; every change refreshes the rows. The sheet comes up by its height
  // and goes down when pulled by its top (lib/motion).
  import type { BaseItem, MediaStream } from '$shared/models';
  import { acceptsList, ApiError, listTargets, previousEpisodes, type Api, type ListKind } from '$tv/api';
  import { removeFromContinue, undoRemove } from '$tv/continue-watching';
  import { clock, episodeLine } from '$tv/format';
  import { t } from '$tv/i18n.svelte';
  import { changed } from '$tv/load.svelte';
  import { play, shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { showToast } from '$tv/toast.svelte';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import Heart from '@lucide/svelte/icons/heart';
  import Info from '@lucide/svelte/icons/info';
  import ListPlus from '@lucide/svelte/icons/list-plus';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import Captions from '@lucide/svelte/icons/captions';
  import CheckCheck from '@lucide/svelte/icons/check-check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import FileVideo from '@lucide/svelte/icons/file-video-camera';
  import Link from '@lucide/svelte/icons/link';
  import Share from '@lucide/svelte/icons/share';
  import Ungroup from '@lucide/svelte/icons/ungroup';
  import Image from '@lucide/svelte/icons/image';
  import Pencil from '@lucide/svelte/icons/pencil';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ScanSearch from '@lucide/svelte/icons/scan-search';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Tv from '@lucide/svelte/icons/tv';
  import Undo from '@lucide/svelte/icons/undo-2';
  import type { Component } from 'svelte';
  import { fade } from 'svelte/transition';
  import { adminActions, closeItemMenu, fetchMenuItem, openItemAdmin, type ItemAdminAction, type ItemMenuContext, type MenuItem } from '../lib/item-menu.svelte';
  import { dragDismiss, sheet } from '../lib/motion';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { showSnack } from '../lib/snackbar.svelte';
  import { canDownload, download, downloadOf } from '../lib/downloads.svelte';
  import { adminKey, adminOf, isAdmin } from '../lib/user.svelte';
  import Spinner from './Spinner.svelte';
  import TextField from './TextField.svelte';

  let { item: shown, ctx }: { item: BaseItem; ctx: ItemMenuContext } = $props();

  // svelte-ignore state_referenced_locally
  const client: Api = apiOf(shown.ServerId)!;
  // svelte-ignore state_referenced_locally
  let item = $state<MenuItem>(shown);
  let admin = $state(adminOf[adminKey(client)] === true);

  $effect(() => {
    void fetchMenuItem(shown).then((it) => (item = it), () => {});
    void isAdmin(client).then((on) => (admin = on));
  });

  const episode = $derived(item.Type === 'Episode');
  const title = $derived(episode && item.SeriesName ? item.SeriesName : item.Name);
  const line = $derived(episode ? (episodeLine(item) ?? '') : [item.ProductionYear, item.OfficialRating].filter(Boolean).join(' · '));
  const art = $derived(client.thumb(item, 240) ?? client.poster(item, 200));
  const at = $derived((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000);
  const playable = $derived(['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'].includes(item.Type ?? ''));
  const shufflable = $derived(['Series', 'Season', 'BoxSet', 'Folder', 'CollectionFolder', 'Playlist'].includes(item.Type ?? ''));
  const played = $derived(item.UserData?.Played === true);
  const favorite = $derived(item.UserData?.IsFavorite === true);

  // ---- Steps: the actions, then a playlist or collection to add to, then the new one's name; or the media info ----
  let info = $state(false);
  let kind = $state<ListKind | null>(null);
  let targets = $state<BaseItem[] | null>(null);
  let naming = $state(false);
  let name = $state('');
  let busy = $state(false);

  function done(): void {
    closeItemMenu();
  }
  // A server call, then the rows reload; a refusal says so.
  async function act(run: () => Promise<unknown>, ok?: string): Promise<void> {
    done();
    try {
      await run();
      changed();
      if (ok) showToast(ok);
    } catch (e) {
      showToast(e instanceof ApiError && e.status ? t('web_action_failed') : t('load_error'));
    }
  }

  function removeContinue(): void {
    // A row painted from the stored cache has its dates as a plain object (JSON keeps no Map).
    const series = ctx.continueRow instanceof Map ? ctx.continueRow : new Map<string, string>();
    const it = item;
    void act(async () => {
      await removeFromContinue(client, it, series);
      showSnack({ text: t('removed_from_continue'), action: t('undo'), run: () => void undoRemove(client, it).then(changed) });
    });
  }

  async function chooseList(k: ListKind): Promise<void> {
    kind = k;
    targets = null;
    targets = await client.lists(k).then((all) => listTargets(k, item, all), () => []);
  }
  async function addTo(list: BaseItem | null): Promise<void> {
    if (!kind || busy) return;
    const k = kind;
    busy = true;
    try {
      if (list) await client.addToList(k, list.Id, item);
      else await client.createList(k, name.trim(), item);
      changed();
      showToast(t('list_added', list?.Name ?? name.trim()));
      done();
    } catch {
      busy = false;
      showToast(t('web_action_failed'));
    }
  }

  function remove(): void {
    const it = item;
    done();
    showAlert({
      title: t('web_delete_title', it.Name),
      message: t('web_delete_body'),
      actions: [
        { label: t('delete'), destructive: true, run: () => void act(() => client.del(`/Items/${it.Id}`), t('web_deleted', it.Name)) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }

  async function markPrevious(): Promise<void> {
    const all = await client.episodes(item.SeriesId!);
    await Promise.all(previousEpisodes(all, item).map((e) => client.setPlayed(e.Id, true)));
  }

  // ---- About the file: Emby's media info, its stream URL, its links ----
  const sources = $derived(item.MediaSources ?? []);
  const links = $derived(item.ExternalUrls?.filter((l) => /^https:\/\//.test(l.Url)) ?? []);
  const shareLink = $derived(links.find((l) => /imdb|themoviedb|thetvdb|trakt/i.test(l.Url))?.Url ?? links[0]?.Url);

  function copyStream(): void {
    const url = client.streamUrl(item, sources[0].Id);
    done();
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(
      () => showToast(t('web_copied')),
      () => showToast(t('web_action_failed')),
    );
  }
  function share(): void {
    done();
    void navigator.share({ title: title ?? undefined, url: shareLink }).catch(() => {});
  }
  // Emby's "Split versions": the versions grouped under this title become titles of their own.
  function split(): void {
    const it = item;
    void act(() => client.del(`/Videos/${it.Id}/AlternateSources`), t('web_split_done'));
  }

  const size = (bytes: number) => (bytes >= 1024 ** 3 ? t('web_gb', (bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })) : t('web_mb', Math.round(bytes / 1024 ** 2).toLocaleString()));
  const rate = (bps: number) => (bps >= 1e6 ? t('web_mbps', (bps / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })) : t('web_kbps', Math.round(bps / 1e3).toLocaleString()));
  // A stream's facts, as Emby's media info lists them, the empty ones left out.
  function facts(s: MediaStream): string[] {
    const x = s as MediaStream & Record<string, unknown>;
    const fps = (x.RealFrameRate ?? x.AverageFrameRate) as number | undefined;
    const range = x.VideoRange && x.VideoRange !== 'SDR' ? (x.ExtendedVideoSubTypeDescription ?? x.VideoRangeType ?? x.VideoRange) : undefined;
    return [
      [s.Codec?.toUpperCase(), x.Profile, x.Level ? `L${x.Level}` : undefined].filter(Boolean).join(' '),
      x.Width && x.Height ? `${x.Width}×${x.Height}` : undefined,
      fps ? t('web_fps', fps.toLocaleString(undefined, { maximumFractionDigits: 3 })) : undefined,
      range ? String(range) : undefined,
      x.BitDepth ? t('web_bits', String(x.BitDepth)) : undefined,
      x.ChannelLayout ? String(x.ChannelLayout) : x.Channels ? t('web_channels', String(x.Channels)) : undefined,
      x.SampleRate ? `${((x.SampleRate as number) / 1000).toLocaleString()} kHz` : undefined,
      x.BitRate ? rate(x.BitRate as number) : undefined,
      s.Language ? String(s.Language) : undefined,
      s.IsDefault ? t('web_default') : undefined,
      s.IsForced ? t('web_forced') : undefined,
      s.IsExternal ? t('web_external') : undefined,
    ].filter((v): v is string => !!v);
  }
  const STREAM: Record<string, string> = { Video: 'web_video', Audio: 'audio', Subtitle: 'subtitles' };

  const ADMIN: Record<ItemAdminAction, [Component, string]> = {
    edit: [Pencil, 'web_admin_edit'],
    identify: [ScanSearch, 'web_admin_identify'],
    images: [Image, 'web_admin_images'],
    refresh: [RefreshCw, 'web_refresh'],
    subtitles: [Captions, 'web_admin_subtitles'],
    delete: [Trash, 'delete'],
  };

  type Row = { icon: Component; label: string; run: () => void; destructive?: boolean; on?: boolean };
  const groups = $derived.by<Row[][]>(() => {
    const g: Row[][] = [];
    const playing: Row[] = [];
    if (playable) {
      if (at > 0) {
        playing.push({ icon: Play, label: t('resume_at', clock(at)), run: () => (done(), play(item)) });
        playing.push({ icon: RotateCcw, label: t('from_start'), run: () => (done(), play(item, { fromStart: true })) });
      } else playing.push({ icon: Play, label: t('play'), run: () => (done(), play(item, { fromStart: true })) });
    }
    if (shufflable) playing.push({ icon: Shuffle, label: t('shuffle'), run: () => (done(), void shuffle(item)) });
    if (playing.length) g.push(playing);

    const going: Row[] = [];
    if (!ctx.onPage) going.push({ icon: Info, label: t('more_info'), run: () => (done(), nav.push(itemRoute(item))) });
    if (episode && item.SeriesId) going.push({ icon: Tv, label: t('web_go_series'), run: () => (done(), nav.push({ name: 'detail', id: item.SeriesId!, serverId: item.ServerId })) });
    if (going.length) g.push(going);

    const mine: Row[] = [{ icon: Check, label: played ? t('mark_unplayed') : t('mark_played'), on: played, run: () => void act(() => client.setPlayed(item.Id, !played)) }];
    if (episode && item.SeriesId) mine.push({ icon: CheckCheck, label: t('mark_previous_played'), run: () => void act(markPrevious) });
    mine.push({ icon: Heart, label: favorite ? t('web_favorite_remove') : t('web_favorite_add'), on: favorite, run: () => void act(() => client.setFavorite(item.Id, !favorite)) });
    if (ctx.continueRow || at > 0) mine.push({ icon: EyeOff, label: t('remove_from_continue'), run: removeContinue });
    if (canDownload(item)) {
      const kept = downloadOf(item.Id);
      mine.push({
        icon: ArrowDownToLine,
        label: kept?.status === 'done' ? t('web_downloaded') : kept ? t('web_downloading') : t('web_download'),
        on: kept?.status === 'done',
        run: () => (done(), kept ? nav.selectTab('downloads') : (download(item), showToast(t('web_download_started')))),
      });
    }
    if (acceptsList('playlist', item)) mine.push({ icon: ListPlus, label: t('add_to_playlist'), run: () => void chooseList('playlist') });
    if (acceptsList('collection', item)) mine.push({ icon: FolderPlus, label: t('add_to_collection'), run: () => void chooseList('collection') });
    g.push(mine);

    const about: Row[] = [];
    if (sources.length) about.push({ icon: FileVideo, label: t('web_media_info'), run: () => (info = true) });
    else if (links.length) about.push({ icon: ExternalLink, label: t('web_links'), run: () => (info = true) });
    if (playable && sources[0]) about.push({ icon: Link, label: t('web_copy_stream'), run: copyStream });
    if (shareLink && typeof navigator.share === 'function') about.push({ icon: Share, label: t('web_share'), run: share });
    if (about.length) g.push(about);

    const manage: Row[] = [];
    if (admin) {
      for (const a of adminActions(item)) {
        const [icon, label] = ADMIN[a];
        if (a === 'delete' && sources.length > 1) manage.push({ icon: Ungroup, label: t('web_split_versions'), run: split });
        manage.push({ icon, label: t(label), destructive: a === 'delete', run: () => (done(), openItemAdmin(item, a)) });
      }
      if (sources.length > 1 && !item.CanDelete) manage.push({ icon: Ungroup, label: t('web_split_versions'), run: split });
    } else if (item.CanDelete) manage.push({ icon: Trash, label: t('delete'), destructive: true, run: remove });
    if (manage.length) g.push(manage);
    return g;
  });
</script>

<div class="scrim" role="presentation" onclick={done} in:fade={{ duration: 240 }} out:fade={{ duration: 200 }}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={title} in:sheet out:sheet={{ duration: 240 }}>
  <div class="grip" use:dragDismiss={done}>
    <span class="handle" aria-hidden="true"></span>
    <div class="head">
      {#if kind}
        <button class="round bare back" aria-label={t('back')} onclick={() => (naming ? (naming = false) : (kind = null))}><ChevronLeft size={22} aria-hidden="true" /></button>
        <p class="headline grow">{kind === 'playlist' ? t('add_to_playlist_title') : t('add_to_collection_title')}</p>
      {:else if info}
        <button class="round bare back" aria-label={t('back')} onclick={() => (info = false)}><ChevronLeft size={22} aria-hidden="true" /></button>
        <p class="headline grow">{sources.length ? t('web_media_info') : t('web_links')}</p>
      {:else}
        <span class="art" style:background-image={art ? `url(${art})` : undefined}></span>
        <span class="grow">
          <span class="headline ellipsis">{title}</span>
          {#if line}<span class="footnote label-2 ellipsis">{line}</span>{/if}
        </span>
      {/if}
    </div>
  </div>

  <div class="rows">
    {#if info}
      {#each sources as src (src.Id)}
        <div class="file">
          {#if sources.length > 1}<p class="headline">{src.Name}</p>{/if}
          <p class="footnote label-2">{[src.Container?.toUpperCase(), src.Size ? size(src.Size) : undefined, src.Bitrate ? rate(src.Bitrate) : undefined].filter(Boolean).join(' · ')}</p>
          {#if admin && (src.Path ?? item.Path)}<p class="caption label-3 path">{src.Path ?? item.Path}</p>{/if}
        </div>
        {#each src.MediaStreams ?? [] as s (s.Index)}
          {#if STREAM[s.Type ?? '']}
            <div class="stream">
              <p class="callout"><span class="label-2">{t(STREAM[s.Type!])}</span> · {s.DisplayTitle ?? s.Codec?.toUpperCase() ?? ''}</p>
              <p class="footnote label-2">{facts(s).join(' · ')}</p>
            </div>
          {/if}
        {/each}
      {/each}
      {#if links.length}
        {#if sources.length}<span class="sep" aria-hidden="true"></span>{/if}
        {#each links as l (l.Url)}
          <a class="row" href={l.Url} target="_blank" rel="noopener noreferrer"><ExternalLink size={20} aria-hidden="true" /><span class="text">{l.Name}</span></a>
        {/each}
      {/if}
    {:else if !kind}
      {#each groups as group, gi (gi)}
        {#if gi > 0}<span class="sep" aria-hidden="true"></span>{/if}
        {#each group as row (row.label)}
          {@const Icon = row.icon}
          <button class="row" class:destructive={row.destructive} class:on={row.on} onclick={row.run}>
            <Icon size={20} aria-hidden="true" />
            <span class="text">{row.label}</span>
          </button>
        {/each}
      {/each}
    {:else if naming}
      <form class="naming" onsubmit={(e) => (e.preventDefault(), name.trim() && void addTo(null))}>
        <TextField bind:value={name} label={kind === 'playlist' ? t('new_playlist_name') : t('new_collection_name')} autocapitalize="sentences" />
        <button class="pill primary" disabled={!name.trim() || busy}>{busy ? '…' : t('list_create')}</button>
      </form>
    {:else if targets === null}
      <div class="wait"><Spinner /></div>
    {:else}
      <button class="row" onclick={() => ((naming = true), (name = ''))}><Plus size={20} aria-hidden="true" /><span class="text">{kind === 'playlist' ? t('new_playlist') : t('new_collection')}</span></button>
      {#if !targets.length}<p class="footnote label-2 empty">{kind === 'playlist' ? t('no_playlists') : t('no_collections')}</p>{/if}
      {#each targets as list (list.Id)}
        <button class="row" disabled={busy} onclick={() => void addTo(list)}><span class="dot" aria-hidden="true"></span><span class="text">{list.Name}</span></button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.45);
    z-index: 50;
  }
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 82%;
    transform: translate3d(0, var(--drag, 0px), 0);
    will-change: transform;
    display: flex;
    flex-direction: column;
    padding: 0 max(12px, var(--safe-right)) calc(var(--safe-bottom) + 10px) max(12px, var(--safe-left));
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--bg-elevated);
    z-index: 51;
  }
  /* The sheet's top pulls it down (lib/motion dragDismiss): no scroll or page gesture starts there. */
  .grip {
    flex: none;
    display: flex;
    flex-direction: column;
    touch-action: none;
  }
  .handle {
    align-self: center;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-4);
    margin: 10px 0 12px;
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px 14px;
    border-bottom: 0.5px solid var(--separator);
    margin-bottom: 6px;
  }
  .art {
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    background: var(--bg-elevated-2) center / cover no-repeat;
    flex: none;
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .back {
    margin-left: -10px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rows {
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .row {
    width: 100%;
    min-height: 50px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
    font-size: var(--fs-body);
  }
  .row :global(svg) {
    color: var(--label-2);
    flex: none;
  }
  .row.on :global(svg) {
    color: var(--accent);
  }
  .row:active {
    background: var(--fill-2);
  }
  .row.destructive,
  .row.destructive :global(svg) {
    color: var(--red);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .sep {
    display: block;
    height: 0.5px;
    margin: 6px 12px;
    background: var(--separator);
  }
  .file {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 12px 6px;
  }
  .path {
    word-break: break-all;
    user-select: text;
    -webkit-user-select: text;
  }
  .stream {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 12px;
    border-top: 0.5px solid var(--separator);
  }
  a.row {
    text-decoration: none;
  }
  .dot {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--fill-3);
    flex: none;
  }
  .naming {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px 12px;
  }
  .empty {
    padding: 8px 12px;
  }
  .wait {
    display: grid;
    place-items: center;
    padding: 28px;
  }
</style>
