<script lang="ts">
  // The signed-in shell's tab roots (Android MainShell): each tab is mounted on its first visit and kept, so a tab
  // shows again where it was left. The tab bar lives in App.svelte, over the tabs' pushed pages too.
  import { runHomeRefresh } from '$tv/auto-refresh';
  import { api } from '$tv/session.svelte';
  import { onMount } from 'svelte';
  import { tabIn } from '../lib/motion';
  import { shell, TABS, type TabId } from '../lib/nav.svelte';
  import HomeTab from '../tabs/HomeTab.svelte';
  import LibrariesTab from '../tabs/LibrariesTab.svelte';
  import SearchTab from '../tabs/SearchTab.svelte';
  import DownloadsTab from '../tabs/DownloadsTab.svelte';
  import SettingsTab from '../tabs/SettingsTab.svelte';
  import { me } from '../lib/user.svelte';
  import { load, save } from '$tv/storage';
  import { t } from '$tv/i18n.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { topInset } from '../lib/viewport';
  import { standalone } from '../platform';

  // A tab switch slides the tab's root in (lib/motion tabIn); a tab showing a pushed page is the page layer's.
  const roots = $state<Partial<Record<TabId, HTMLElement>>>({});
  let shown = shell.tab;
  $effect(() => {
    const tab = shell.tab;
    if (tab === shown) return;
    shown = tab;
    const el = roots[tab];
    if (el && shell.op === 'tab') tabIn(el, shell.dir);
  });
  const visited = $state<Record<TabId, boolean>>({ home: true, libraries: false, search: false, downloads: false, settings: false });
  $effect.pre(() => {
    visited[shell.tab] = true;
  });
  // The rows reload by themselves (TV web Main, Android HomeRefresh): back in the app, on the server's changes
  // (another device playing, a library scan), every 5 min; after a video, once its Stopped report is in.
  onMount(() => {
    // An app added to the Home Screen while its status bar was translucent keeps it (iOS reads index.html's meta at
    // install), and iOS then always blurs the top (app.css .status-colour). Once, how to get rid of it.
    if (standalone && topInset() > 0 && window.innerHeight > window.innerWidth && !load<boolean>('statusHint3', false)) {
      save('statusHint3', true);
      showAlert({ title: t('web_status_hint_title'), message: t('web_status_hint_body'), actions: [{ label: t('web_got_it'), run: () => {} }] });
    }
    // The account's picture and rights, once per start.
    void me(api()!);
    return runHomeRefresh(api()!);
  });
</script>

{#each TABS as tab (tab)}
  {#if visited[tab]}
    <div class="tab" class:on={shell.tab === tab} inert={shell.tab !== tab} bind:this={roots[tab]}>
      {#if tab === 'home'}<HomeTab />
      {:else if tab === 'libraries'}<LibrariesTab />
      {:else if tab === 'search'}<SearchTab />
      {:else if tab === 'downloads'}<DownloadsTab />
      {:else}<SettingsTab />{/if}
    </div>
  {/if}
{/each}

<style>
  .tab {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  .on {
    visibility: visible;
  }
</style>
