<script lang="ts">
  // Settings > Home's rows (Android TV's Home rows editor, TP-07): each row Home can show, in its order, with a
  // switch to show it, arrows to move it, and for a library's Recently added row its cards as thumbnails or posters.
  // Saved per account; Home follows at once.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import GalleryHorizontal from '@lucide/svelte/icons/gallery-horizontal';
  import { flip } from 'svelte/animate';
  import { useHomeLayout } from '../../lib/home.svelte';
  import Chips from './Chips.svelte';

  let { views }: { views: () => BaseItem[] } = $props();
  // svelte-ignore state_referenced_locally
  const layout = useHomeLayout(views);
  const rows = $derived(layout.rows);
</script>

{#if rows.some((r) => r.wide !== null)}
  <!-- Every Recently added row at once; the thumbnail button on a row changes that row alone. -->
  <Chips
    label={t('web_latest_style')}
    options={[t('web_latest_posters'), t('web_latest_thumbs')]}
    selected={layout.anyWide ? 1 : 0}
    onpick={(i) => layout.allWide(i === 1)}
  />
{/if}
{#each rows as row, i (row.id)}
  <div class="row" class:off={row.hidden} animate:flip={{ duration: 260 }}>
    <input class="switch" type="checkbox" switch checked={!row.hidden} aria-label={row.label} onchange={() => layout.toggle(row.id)} />
    <span class="label ellipsis">{row.label}</span>
    {#if row.wide !== null}
      <button class="tool" class:on={row.wide} aria-pressed={row.wide} aria-label={t('web_row_thumbs')} onclick={() => layout.wide(row.id)}><GalleryHorizontal size={18} aria-hidden="true" /></button>
    {/if}
    <button class="tool" aria-label={t('web_move_up')} disabled={i === 0} onclick={() => layout.move(row.id, -1)}><ChevronUp size={20} aria-hidden="true" /></button>
    <button class="tool" aria-label={t('web_move_down')} disabled={i === rows.length - 1} onclick={() => layout.move(row.id, 1)}><ChevronDown size={20} aria-hidden="true" /></button>
  </div>
{/each}
<button class="reset accent" onclick={() => layout.reset()}>{t('web_rows_reset')}</button>

<style>
  .row {
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 14px;
    background: var(--bg-elevated);
  }
  .label {
    flex: 1;
    min-width: 0;
    margin-left: 6px;
    transition: opacity var(--t-fast) linear;
  }
  .off .label {
    opacity: 0.45;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .switch {
    flex: none;
    margin: 0;
    accent-color: var(--green);
    width: 51px;
    height: 31px;
  }
  .tool {
    flex: none;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .tool:active:not(:disabled) {
    background: var(--fill-2);
  }
  .tool:disabled {
    opacity: 0.3;
  }
  .tool.on {
    color: var(--accent);
  }
  .reset {
    width: 100%;
    min-height: 48px;
    padding: 0 16px;
    text-align: left;
    color: var(--accent);
    background: var(--bg-elevated);
  }
</style>
