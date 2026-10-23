<script lang="ts">
  // Téléchargés (lib/downloads): what is kept on the phone, newest first, each with its poster, its progress while it
  // comes down, and what can be done with it (play, retry, delete); the space used and left on top. A tap plays it,
  // from where it stopped, online or not.
  import { episodeLine } from '$tv/format';
  import { t } from '$tv/i18n.svelte';
  import { play } from '$tv/playback';
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import Play from '@lucide/svelte/icons/play';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Trash from '@lucide/svelte/icons/trash-2';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import { downloads, posterOf, remove, retry, usage, type Download } from '../lib/downloads.svelte';
  import { showAlert } from '../lib/overlay.svelte';

  const posters = $state<Record<string, string | undefined>>({});
  $effect(() => {
    for (const d of downloads.list) if (d.status === 'done' && !(d.id in posters)) void posterOf(d).then((u) => (posters[d.id] = u));
  });

  let space = $state<{ used: number; free: number } | null>(null);
  $effect(() => {
    void downloads.list.map((d) => d.status).join();
    void usage().then((u) => (space = u));
  });

  function size(bytes: number): string {
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? t('web_gb', gb.toLocaleString(undefined, { maximumFractionDigits: 1 })) : t('web_mb', Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString());
  }
  const titleOf = (d: Download) => (d.item.Type === 'Episode' && d.item.SeriesName ? d.item.SeriesName : d.item.Name);
  const lineOf = (d: Download) => (d.item.Type === 'Episode' ? (episodeLine(d.item) ?? '') : (d.item.ProductionYear?.toString() ?? ''));
  function status(d: Download): string {
    if (d.status === 'done') return size(d.size);
    if (d.status === 'queued') return t('web_download_queued');
    if (d.status === 'failed') return d.error === 'conversion' ? t('web_download_conversion') : d.error === 'quota' ? t('web_download_quota') : t('web_download_failed');
    return d.size ? `${size(d.received)} / ${size(d.size)}` : size(d.received);
  }

  function ask(d: Download): void {
    showAlert({
      title: titleOf(d),
      message: lineOf(d) || undefined,
      actions: [
        ...(d.status === 'done' ? [{ label: t('play'), run: () => play(d.item) }] : []),
        ...(d.status === 'failed' && d.error !== 'conversion' ? [{ label: t('web_retry'), run: () => retry(d.id) }] : []),
        { label: d.status === 'done' ? t('web_download_delete') : t('web_download_cancel'), destructive: true, run: () => void remove(d.id) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }
</script>

<LargeTitlePage title={t('nav_downloads')} tab="downloads">
  {#if space && downloads.list.length}
    <div class="space">
      <span class="bar"><span style:transform="scaleX({space.used / (space.used + space.free)})"></span></span>
      <span class="footnote label-2">{t('web_space', size(space.used), size(space.free))}</span>
    </div>
  {/if}

  {#if !downloads.list.length}
    <div class="empty">
      <span class="badge"><ArrowDownToLine size={30} aria-hidden="true" /></span>
      <p class="title-3">{t('web_downloads_empty')}</p>
      <p class="callout label-2">{t('web_downloads_hint')}</p>
    </div>
  {:else}
    <div class="list">
      {#each downloads.list as d (d.id)}
        <div class="row">
          <button class="main pressable" onclick={() => (d.status === 'done' ? play(d.item) : ask(d))}>
            <span class="art" style:background-image={posters[d.id] ? `url(${posters[d.id]})` : undefined}>
              {#if d.status === 'done'}<span class="disc"><Play size={16} fill="currentColor" strokeWidth={0} aria-hidden="true" /></span>{/if}
            </span>
            <span class="text">
              <span class="headline ellipsis">{titleOf(d)}</span>
              {#if lineOf(d)}<span class="footnote label-2 ellipsis">{lineOf(d)}</span>{/if}
              <span class="footnote ellipsis" class:label-3={d.status !== 'failed'} class:bad={d.status === 'failed'}>{status(d)}</span>
              {#if d.status === 'downloading'}
                <span class="progress"><span style:transform="scaleX({d.size ? d.received / d.size : 0})"></span></span>
              {/if}
            </span>
          </button>
          {#if d.status === 'failed' && d.error !== 'conversion'}
            <button class="round small" aria-label={t('web_retry')} onclick={() => retry(d.id)}><RotateCw size={18} aria-hidden="true" /></button>
          {/if}
          <button class="round small" aria-label={t('web_download_delete')} onclick={() => ask(d)}><Trash size={18} aria-hidden="true" /></button>
        </div>
      {/each}
    </div>
    {#if downloads.list.some((d) => d.status === 'downloading' || d.status === 'queued')}
      <p class="footnote label-3 note">{t('web_downloads_open')}</p>
    {/if}
  {/if}
  <div class="end"></div>
</LargeTitlePage>

<style>
  .space {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 max(var(--gutter), var(--safe-right)) 18px max(var(--gutter), var(--safe-left));
  }
  .bar,
  .progress {
    display: block;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .bar > span,
  .progress > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--t-med) var(--ease-out);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 80px 32px 0;
    text-align: center;
  }
  .badge {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--fill-1);
    color: var(--label-2);
    margin-bottom: 8px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 max(calc(var(--gutter) - 8px), var(--safe-right)) 0 max(calc(var(--gutter) - 8px), var(--safe-left));
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px;
    border-radius: var(--r-md, 12px);
    text-align: left;
    color: var(--label);
  }
  .art {
    position: relative;
    flex: none;
    width: 64px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-sm);
    background: var(--bg-elevated-2) center / cover no-repeat;
  }
  .disc {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .progress {
    margin-top: 4px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bad {
    color: var(--red);
  }
  .round.small {
    flex: none;
    width: 40px;
    height: 40px;
  }
  .note {
    padding: 14px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .end {
    height: 40px;
  }
</style>
