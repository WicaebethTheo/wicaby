<script lang="ts">
  // Settings > Appearance: the libraries' order, with arrows (the Bibliothèques tab moves them by hand too), and
  // back to the server's order.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import { flip } from 'svelte/animate';
  import { uniqueBy } from '../../lib/diagnostics';
  import { arranged, moved, setOrder } from '../../lib/library-order.svelte';

  let { api, views }: { api: Api; views: () => BaseItem[] } = $props();
  const list = $derived(arranged(api, uniqueBy(views(), (v) => v.Id)));

  function move(i: number, by: number): void {
    const ids = moved(list, i, i + by).map((v) => v.Id);
    setOrder(api, ids);
  }
</script>

{#each list as v, i (v.Id)}
  <div class="row" animate:flip={{ duration: 260 }}>
    <span class="label ellipsis">{v.Name}</span>
    <button class="tool" aria-label={t('web_move_up')} disabled={i === 0} onclick={() => move(i, -1)}><ChevronUp size={20} aria-hidden="true" /></button>
    <button class="tool" aria-label={t('web_move_down')} disabled={i === list.length - 1} onclick={() => move(i, 1)}><ChevronDown size={20} aria-hidden="true" /></button>
  </div>
{/each}
<button class="reset accent" onclick={() => setOrder(api, [])}>{t('web_library_order_reset')}</button>

<style>
  .row {
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 16px;
    background: var(--bg-elevated);
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .reset {
    width: 100%;
    min-height: 48px;
    padding: 0 16px;
    text-align: left;
    color: var(--accent);
    background: var(--bg-elevated);
  }
</style>
