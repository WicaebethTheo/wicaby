<script lang="ts">
  // A page not built on the phone yet (details, grids, players: M1-M3): its bar, so navigation already works.
  import { t } from '$tv/i18n.svelte';
  import NavBar from '../components/NavBar.svelte';
  import type { Route } from '../lib/nav.svelte';

  let { route }: { route: Route } = $props();
  const title = $derived('title' in route ? route.title : '');
</script>

<div class="page">
  <NavBar {title} />
  <p class="callout label-2 note">{t('web_coming')}</p>
</div>

<style>
  .page {
    height: 100%;
    position: relative;
  }
  .note {
    padding: calc(var(--safe-top) + 64px) var(--gutter) 0;
    text-align: center;
  }
</style>
