<script lang="ts">
  // The desktop's modal Sheet (same props) as the phone draws a form: a sheet rising from the bottom over a scrim,
  // the whole width, up to just under the status bar, its content scrolling inside; a handle, a close button, Back
  // and a tap outside close it. Lives on #app (the page layer, sized to the screen by lib/viewport.ts).
  import X from '@lucide/svelte/icons/x';
  import { getContext, type Snippet } from 'svelte';
  import { fade } from 'svelte/transition';
  import { sheet } from '../lib/motion';
  import { t } from '$tv/i18n.svelte';
  import { onBack, SCREEN } from '../lib/nav.svelte';

  let {
    open,
    onclose,
    label,
    onback,
    children,
  }: { open: boolean; onclose: () => void; label: string; width?: number; align?: 'center' | 'top'; onback?: () => void; children: Snippet } = $props();

  const screen = getContext<number>(SCREEN);
  $effect(() => {
    if (!open) return;
    return onBack(screen, () => ((onback ?? onclose)(), true));
  });

  function portal(node: HTMLElement) {
    (document.getElementById('app') ?? document.body).appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

{#if open}
  <div class="layer" use:portal>
    <div class="scrim" role="presentation" onclick={onclose} transition:fade={{ duration: 180 }}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label={label} in:sheet out:sheet={{ duration: 240 }}>
      <span class="handle" aria-hidden="true"></span>
      <div class="body">{@render children()}</div>
      <button class="close" onclick={onclose} aria-label={t('close')}><X size={18} strokeWidth={2.4} aria-hidden="true" /></button>
    </div>
  </div>
{/if}

<style>
  .layer {
    position: absolute;
    inset: 0;
    z-index: 60;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.45);
  }
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: calc(100% - var(--safe-top) - 12px);
    display: flex;
    flex-direction: column;
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--bg-elevated);
    color: var(--label);
    box-shadow: var(--shadow-3);
  }
  .handle {
    align-self: center;
    flex: none;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-4);
    margin: 10px 0 4px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    /* The bottom safe area is the content's own (desktop/admin.css): a sticky action bar covers it. */
    padding: 0 var(--safe-right) 0 var(--safe-left);
  }
  .close {
    position: absolute;
    top: 14px;
    right: max(14px, var(--safe-right));
    z-index: 3;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label-2);
    background: var(--fill-2);
  }
</style>
