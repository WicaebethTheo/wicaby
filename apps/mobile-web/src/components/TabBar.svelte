<script lang="ts">
  // The tab bar, as the Android mobile app's (MainShell's NavigationBar): the full width at the bottom, on the
  // elevated surface, four tabs with their labels; the current one has a soft pill behind its icon (selection
  // shows as a fill, never as the accent). The pill slides to the tab tapped, stretching a little on the way (the
  // Graphite easing, no bounce). Settings has no tab: it opens from the account menu (ProfileButton). A tap on the
  // current tab returns it to its root, or to its top.
  import Download from '@lucide/svelte/icons/download';
  import House from '@lucide/svelte/icons/house';
  import Library from '@lucide/svelte/icons/library';
  import Search from '@lucide/svelte/icons/search';
  import { t } from '$tv/i18n.svelte';
  import { nav, shell, type TabId } from '../lib/nav.svelte';
  import { look } from '../lib/look.svelte';
  import { reducedMotion } from '../lib/motion';

  const TABS: { id: TabId; icon: typeof House; label: string }[] = [
    { id: 'home', icon: House, label: 'tab_home' },
    { id: 'libraries', icon: Library, label: 'nav_libraries' },
    { id: 'downloads', icon: Download, label: 'nav_downloads' },
    { id: 'search', icon: Search, label: 'tab_search' },
  ];
  const index = $derived(Math.max(0, TABS.findIndex((t) => t.id === shell.tab)));

  let pill = $state<HTMLElement>();
  let from = -1;
  $effect(() => {
    const to = index;
    if (from >= 0 && from !== to && pill && !reducedMotion()) {
      // Stretched the more the farther it goes, back to its size as it arrives.
      const stretch = 1 + Math.min(0.4, 0.14 * Math.abs(to - from));
      pill.animate(
        [
          { transform: `translate3d(${from * 100}%, 0, 0)` },
          { transform: `translate3d(${(from + (to - from) * 0.55) * 100}%, 0, 0) scaleX(${stretch})`, offset: 0.45 },
          { transform: `translate3d(${to * 100}%, 0, 0)` },
        ],
        { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      );
    }
    from = to;
  });
</script>

<nav class="bar" class:bare={!look.tabLabels} aria-label="Wicaby">
  <div class="tabs">
    <span class="slot" bind:this={pill} style:transform="translate3d({index * 100}%, 0, 0)" aria-hidden="true"><span class="pill"></span></span>
    {#each TABS as tab (tab.id)}
      {@const on = shell.tab === tab.id}
      <button
        class="tab"
        class:on
        aria-current={on ? 'page' : undefined}
        onclick={() => nav.selectTab(tab.id)}
      >
        <span class="icon"><tab.icon size={22} strokeWidth={on ? 2 : 1.6} aria-hidden="true" /></span>
        {#if look.tabLabels}<span class="name">{t(tab.label)}</span>{/if}
      </button>
    {/each}
  </div>
</nav>

<style>
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--tabbar);
    padding: 6px max(4px, var(--safe-right)) var(--tabbar-inset) max(4px, var(--safe-left));
    display: flex;
    background: var(--bg-elevated);
    border-top: 0.5px solid var(--separator);
    z-index: 10;
  }
  .tabs {
    position: relative;
    flex: 1;
    display: flex;
    min-width: 0;
  }
  /* A quarter of the row, moved by whole quarters; the pill sits where a tab's icon does. */
  .slot {
    position: absolute;
    top: 0;
    left: 0;
    width: 25%;
    height: 56px;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .pill {
    width: 58px;
    height: 30px;
    margin-top: calc(28px - 23.5px);
    border-radius: 15px;
    background: var(--fill-3);
  }
  .bare .pill {
    margin-top: 13px;
  }
  .tab {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    color: var(--label-2);
  }
  .icon {
    width: 58px;
    height: 30px;
    display: grid;
    place-items: center;
  }
  .tab {
    transition: color 240ms var(--ease);
  }
  .on {
    color: var(--label);
  }
  .name {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    padding: 0 2px;
  }
</style>
