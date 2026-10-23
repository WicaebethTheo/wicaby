<script lang="ts">
  // A page under a top row, as Instagram and Netflix lay theirs out: right under the status bar, the title on the left
  // (large on a tab's root, beside a round Back button on a pushed page), the page's own actions and the account on
  // the right. The row stays while the content scrolls under it; it is the canvas itself (opaque, never a blur over
  // the content), with a hairline once something has gone under it. A tap on the current tab's icon at its root
  // scrolls back to the top.
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import type { Snippet } from 'svelte';
  import { t } from '$tv/i18n.svelte';
  import { handleBack, shell, type TabId } from '../lib/nav.svelte';
  import ProfileButton from './ProfileButton.svelte';

  let {
    title,
    tab,
    back = false,
    trailing,
    header,
    children,
    scroller = $bindable(),
  }: { title: string; tab?: TabId; back?: boolean; trailing?: Snippet; header?: Snippet; children: Snippet; scroller?: HTMLElement } = $props();

  let scrolled = $state(false);

  let seen = shell.reselect;
  $effect(() => {
    if (shell.reselect !== seen && shell.tab === tab) scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    seen = shell.reselect;
  });
</script>

<div class="page">
  <div class="scroller" data-scroll bind:this={scroller} onscroll={() => (scrolled = scroller!.scrollTop > 2)}>
    {@render header?.()}
    {@render children()}
  </div>
  <header class="top" class:scrolled>
    {#if back}
      <button class="back-btn round bare" aria-label={t('back')} onclick={() => handleBack()}><ChevronLeft size={26} strokeWidth={2.2} aria-hidden="true" /></button>
    {/if}
    <h1 class="name ellipsis" class:root={!back}>{title}</h1>
    {#if trailing}<div class="trailing">{@render trailing()}</div>{/if}
    <!-- The account, on every tab's root but Settings (which opens with it). -->
    {#if tab && tab !== 'settings'}<ProfileButton />{/if}
  </header>
</div>

<style>
  .page {
    position: relative;
    height: 100%;
  }
  .scroller {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding: calc(var(--top-bar) + 4px) 0 calc(var(--tabbar) + 16px);
  }
  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--top-bar);
    padding: var(--safe-top) max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg);
    box-shadow: 0 0.5px 0 transparent;
    transition: box-shadow var(--t-fast) linear;
    z-index: 4;
  }
  .top.scrolled {
    box-shadow: 0 0.5px 0 var(--separator);
  }
  .back-btn {
    width: 36px;
    height: 36px;
    margin-left: -8px;
    flex: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    margin: 0;
    line-height: 1.15;
    font-size: var(--fs-title-3);
    font-weight: 750;
    letter-spacing: -0.02em;
  }
  .name.root {
    font-size: var(--fs-title-1);
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trailing {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
</style>
