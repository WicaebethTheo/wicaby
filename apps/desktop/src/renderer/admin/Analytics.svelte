<script lang="ts">
  // Library analytics: what the server's files are made of (types, codecs, containers, resolutions, HDR,
  // subtitles and audio languages), for every library or one. Scans page through /Items with the media
  // fields; results are cached per library (analytics/scan.ts) until "Refresh". Emby and Jellyfin only,
  // as the whole Administration page (caps().admin).
  import { onDestroy, onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import { aggregate, inBucket, toCsv, type Bucket, type Facet, type LibraryInfo, type ScanRow } from '../../shared/library-analytics';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { fmt, has, t } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, serverName } from '../lib/stores.svelte';
  import { loadScan, saveScan, scanLibrary, type CachedScan } from './analytics/scan';
  import { contentType, libraryAdmin } from './libraries/libraryAdmin';
  import { saveTextFile } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();

  const admin = $derived(libraryAdmin(serverId, kindProp));
  const kind = $derived<ServerKind>(kindProp ?? admin.kind());

  let libs = $state<LibraryInfo[] | null>(null);
  let scope = $state('all');
  // Raw: scans are only ever replaced whole, and deep proxies over thousands of rows are costly.
  let scans = $state.raw<Record<string, CachedScan>>({});
  let scanning = $state<{ name: string; done: number; total: number } | null>(null);
  let error = $state('');
  // Bumped to stop the scan in flight (scope change, refresh, leaving the page).
  let run = 0;
  // A scan can still be started after leaving (loadLibraries resolving late).
  let gone = false;
  onDestroy(() => {
    gone = true;
    run++;
  });

  const scopeLibs = $derived((libs ?? []).filter((l) => scope === 'all' || l.id === scope));
  const missing = $derived(scopeLibs.filter((l) => !scans[l.id]));
  const rows = $derived<ScanRow[]>(missing.length ? [] : scopeLibs.flatMap((l) => scans[l.id].rows));
  const stats = $derived(missing.length ? null : aggregate(rows, scopeLibs));
  // The oldest scan of the scope is the one the figures are as fresh as.
  const scannedAt = $derived(missing.length ? '' : scopeLibs.map((l) => scans[l.id].at).sort()[0] ?? '');

  // Admin.svelte remounts the section for another server.
  onMount(() => void loadLibraries());

  async function loadLibraries(): Promise<void> {
    try {
      const folders = await admin.folders();
      const list = folders.filter((f) => f.ItemId).map((f) => ({ id: f.ItemId!, name: f.Name, type: contentType(f) }));
      const cached = await Promise.all(list.map((l) => loadScan(serverId, l.id)));
      scans = Object.fromEntries(list.flatMap((l, i) => (cached[i] ? [[l.id, cached[i]]] : [])));
      libs = list;
      error = '';
      void scan(false);
    } catch (err) {
      error = errorMessage(err);
      libs ??= [];
    }
  }

  // force: rescan the scope even where a cached result exists.
  async function scan(force: boolean): Promise<void> {
    if (gone) return;
    const mine = ++run;
    const todo = scopeLibs.filter((l) => force || !scans[l.id]);
    try {
      for (const l of todo) {
        scanning = { name: l.name, done: 0, total: 0 };
        const result = await scanLibrary(serverId, kind, l.id, (done, total) => mine === run && (scanning = { name: l.name, done, total }), () => mine === run);
        if (!result) return;
        const entry = { at: new Date().toISOString(), rows: result };
        scans = { ...scans, [l.id]: entry };
        void saveScan(serverId, l.id, entry);
      }
      error = '';
    } catch (err) {
      if (mine === run) error = errorMessage(err);
    } finally {
      if (mine === run) scanning = null;
    }
  }

  function pickScope(value: string): void {
    if (value === scope) return;
    scope = value;
    void scan(false);
  }

  const scopeOptions = $derived([{ value: 'all', label: t('adminAnalytics.all') }, ...(libs ?? []).map((l) => ({ value: l.id, label: l.name }))]);
  const libName = (id: string) => libs?.find((l) => l.id === id)?.name ?? id;
  const pct = (p: number) => fmt.number(p, { style: 'percent', maximumFractionDigits: p > 0 && p < 0.1 ? 1 : 0 });
  const typeLabel = (type: string) => (has(`adminLibraries.types.${type}`) ? t(`adminLibraries.types.${type}`) : type);

  // Technical names, the same in every language.
  const RES: Record<string, string> = { '4k': '4K', '1080p': '1080p', '720p': '720p', sd: 'SD' }; // i18n-ignore
  const HDR: Record<string, string> = { hdr10: 'HDR10', 'hdr10+': 'HDR10+', dv: 'Dolby Vision', hlg: 'HLG' }; // i18n-ignore
  function label(facet: Facet, key: string): string {
    if (facet === 'type') return t(`adminAnalytics.types.${key}`);
    if (facet === 'res') return RES[key] ?? key;
    if (facet === 'hdr') return HDR[key] ?? key;
    if (facet === 'noSubs') return t('adminAnalytics.quality.noSubs');
    if (facet === 'oneLang') return t('adminAnalytics.quality.oneLang');
    return key === '?' ? t('adminAnalytics.unknown') : key;
  }

  function split(counts: Record<string, number>): string {
    return Object.entries(counts)
      .filter(([, n]) => n)
      .map(([k, n]) => t(`adminAnalytics.counts.${k}`, { count: n }))
      .join(' · ');
  }

  // ---- Drill-down ----
  const DRILL_MAX = 500;
  let drill = $state<{ facet: Facet; key: string } | null>(null);
  const drillRows = $derived(drill ? rows.filter((r) => inBucket(r, drill!.facet, drill!.key)) : []);

  function streamInfo(r: ScanRow): string {
    const dims = r.width && r.height ? `${r.width}×${r.height}` : '';
    const video = [r.video === '?' ? '' : r.video, dims, r.hdr ? HDR[r.hdr] : ''].filter(Boolean).join(' ');
    return [video, r.audio?.filter((a) => a !== '?').join(', '), r.container, r.size ? fmt.bytes(r.size) : ''].filter(Boolean).join(' · ');
  }

  function open(r: ScanRow): void {
    drill = null;
    navigate(`/item/${serverId}/${r.id}`);
  }

  // ---- Export ----
  function fileName(ext: string): string {
    const scopeName = scope === 'all' ? t('adminAnalytics.all') : libName(scope);
    return `${serverName(serverId)} ${scopeName} ${scannedAt.slice(0, 10)}.${ext}`.replace(/[\\/:*?"<>|]+/g, '-');
  }
  const exportCsv = () => saveTextFile(fileName('csv'), toCsv(rows, libName));
  function exportJson(): void {
    const data = { server: serverName(serverId), kind, scope: scope === 'all' ? 'all' : libName(scope), scannedAt, summary: stats, items: rows };
    saveTextFile(fileName('json'), JSON.stringify(data, null, 2));
  }
</script>

{#snippet bucketGroup(title: string, facet: Facet, list: Bucket[])}
  <section>
    <h3 class="a-gh">{title}</h3>
    <div class="a-group">
      {#each list as b (b.key)}
        {@render bucketRow(facet, b)}
      {:else}
        <p class="a-empty">{t('adminAnalytics.none')}</p>
      {/each}
    </div>
  </section>
{/snippet}

{#snippet bucketRow(facet: Facet, b: Bucket)}
  <button type="button" class="a-row compact bucket" disabled={!b.count} onclick={() => (drill = { facet, key: b.key })}>
    <span class="a-txt">
      <span class="a-lbl soft">{label(facet, b.key)}</span>
      <span class="a-progress meter" aria-hidden="true"><span style:--p={b.pct}></span></span>
    </span>
    <span class="a-val">{t('adminAnalytics.countPct', { count: fmt.number(b.count), pct: pct(b.pct) })}</span>
  </button>
{/snippet}

<div class="an">
  <div class="top">
    {#if libs && libs.length}
      {#if scopeOptions.length <= 5}
        <Segmented label={t('adminAnalytics.scope')} value={scope} options={scopeOptions} onchange={pickScope} />
      {:else}
        <Picker label={t('adminAnalytics.scope')} value={scope} options={scopeOptions} onchange={pickScope} />
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if scannedAt && !scanning}
      <span class="when">{t('adminAnalytics.scannedAt', { date: fmt.date(scannedAt), time: fmt.time(scannedAt) })}</span>
    {/if}
    <button type="button" class="a-push" disabled={!!scanning || (!libs?.length && !error)} onclick={() => (libs?.length ? scan(true) : loadLibraries())}>
      <Icon name="refresh" size={14} />
      {t('common.actions.refresh')}
    </button>
    <button type="button" class="a-push" disabled={!stats || !!scanning} onclick={exportCsv}>
      <Icon name="download" size={14} />
      {t('adminAnalytics.export.csv')}
    </button>
    <button type="button" class="a-push" disabled={!stats || !!scanning} onclick={exportJson}>
      <Icon name="download" size={14} />
      {t('adminAnalytics.export.json')}
    </button>
  </div>

  <div class="scan" aria-live="polite">
    {#if scanning}
      <span class="caption">
        {scanning.total ? t('adminAnalytics.scan.progress', { name: scanning.name, done: fmt.number(scanning.done), total: fmt.number(scanning.total) }) : t('adminAnalytics.scan.starting', { name: scanning.name })}
      </span>
      <span class="a-progress" role="progressbar" aria-label={t('adminAnalytics.scan.label')} aria-valuemin={0} aria-valuemax={scanning.total || 1} aria-valuenow={scanning.done}>
        <span style:--p={scanning.total ? scanning.done / scanning.total : 0}></span>
      </span>
    {/if}
  </div>

  {#if error}<p class="err">{error}</p>{/if}

  {#if libs === null}
    <div class="skeleton loading"></div>
  {:else if libs.length === 0}
    {#if !error}
      <div class="a-group"><p class="a-empty">{t('adminAnalytics.noLibraries')}</p></div>
    {/if}
  {:else if !stats}
    {#if !scanning}
      <div class="a-group"><p class="a-empty">{t('adminAnalytics.notScanned')}</p></div>
    {/if}
  {:else}
    <div class="totals">
      <div class="tile"><span class="num">{fmt.number(stats.total)}</span><span class="cap">{t('adminAnalytics.totals.items')}</span></div>
      <div class="tile"><span class="num">{fmt.number(stats.libraries)}</span><span class="cap">{t('adminAnalytics.totals.libraries')}</span></div>
      <div class="tile"><span class="num">{fmt.bytes(stats.size)}</span><span class="cap">{t('adminAnalytics.totals.size')}</span></div>
    </div>

    <div class="cols">
      {@render bucketGroup(t('adminAnalytics.groups.types'), 'type', stats.types)}
      {@render bucketGroup(t('adminAnalytics.groups.resolution'), 'res', stats.resolutions)}
      {@render bucketGroup(t('adminAnalytics.groups.video'), 'video', stats.video)}
      {@render bucketGroup(t('adminAnalytics.groups.audio'), 'audio', stats.audio)}
      {@render bucketGroup(t('adminAnalytics.groups.containers'), 'container', stats.containers)}
      {@render bucketGroup(t('adminAnalytics.groups.hdr'), 'hdr', stats.hdr)}
      <section>
        <h3 class="a-gh">{t('adminAnalytics.groups.quality')}</h3>
        <div class="a-group">
          {@render bucketRow('noSubs', stats.noSubs)}
          {@render bucketRow('oneLang', stats.oneLang)}
        </div>
      </section>
    </div>
    <p class="a-foot">{t('adminAnalytics.foot')}</p>

    <h3 class="a-gh">{t('adminAnalytics.groups.libraries')}</h3>
    <div class="a-group">
      {#each stats.perLibrary as l (l.id)}
        <div class="a-row">
          <span class="a-txt">
            <span class="a-lbl">{l.name}<span class="tag">{typeLabel(l.type)}</span></span>
            <span class="a-desc">{[t('adminAnalytics.library.total', { count: l.total }), split(l.counts)].filter(Boolean).join(' · ')}</span>
          </span>
          <span class="a-val right">
            <span>{fmt.bytes(l.size)}</span>
            {#if l.bitrate}<span class="caption">{t('adminAnalytics.library.bitrate', { rate: fmt.bitrate(l.bitrate / 1e6, 1) })}</span>{/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Sheet open={drill !== null} onclose={() => (drill = null)} label={drill ? label(drill.facet, drill.key) : ''} width={640}>
  {#if drill}
    <div class="a-sheet drill">
      <h2>{label(drill.facet, drill.key)}</h2>
      <p>{drillRows.length > DRILL_MAX ? t('adminAnalytics.drill.capped', { shown: fmt.number(DRILL_MAX), count: fmt.number(drillRows.length) }) : t('adminAnalytics.drill.count', { count: drillRows.length })}</p>
      <div class="a-group list">
        {#each drillRows.slice(0, DRILL_MAX) as r (r.lib + r.id)}
          <button type="button" class="a-row compact link-row" onclick={() => open(r)}>
            <span class="a-txt">
              <span class="a-lbl">{r.name}</span>
              <span class="a-desc mono">{r.path ?? libName(r.lib)}</span>
              {#if streamInfo(r)}<span class="a-desc">{streamInfo(r)}</span>{/if}
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        {/each}
      </div>
    </div>
  {/if}
</Sheet>

<style>
  .top {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }
  .spacer {
    flex: 1;
  }
  .when,
  .caption {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .scan {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 4px;
    margin-bottom: 16px;
  }
  .err {
    margin: 0 0 12px;
    font-size: var(--fs-callout);
    color: var(--danger);
  }
  .loading {
    height: 220px;
    border-radius: var(--r-sm);
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 18px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .num {
    font-size: var(--fs-title-3);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--label);
  }
  .cap {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0 24px;
    align-items: start;
  }
  .bucket {
    width: 100%;
    text-align: left;
  }
  .bucket:hover:not(:disabled),
  .bucket:focus-visible,
  .link-row:hover,
  .link-row:focus-visible {
    background: var(--fill-1);
  }
  .bucket:disabled {
    opacity: 0.55;
  }
  .meter {
    margin-top: 6px;
    height: 3px;
  }
  .tag {
    font-size: var(--fs-footnote);
    font-weight: 400;
    color: var(--label-3);
  }
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .drill .list {
    max-height: min(60vh, 560px);
    overflow-y: auto;
  }
  .link-row {
    width: 100%;
    text-align: left;
    color: var(--label-3);
  }
  .mono {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
