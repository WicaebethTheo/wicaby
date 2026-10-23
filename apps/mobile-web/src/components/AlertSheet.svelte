<script lang="ts">
  // The dialog layer (lib/overlay.svelte.ts), in Wicaby's own forms (Android PlayerSheet / StillWatching, the
  // desktop's Sheet): a choice or a list of actions is a bottom sheet (a handle, a small caps title, rows, the
  // chosen one checked in the accent); a question with one or two answers is a centred card with pill buttons.
  // A tap outside closes either.
  import Check from '@lucide/svelte/icons/check';
  import { fade } from 'svelte/transition';
  import { pop, sheet as rise } from '../lib/motion';
  import { closeAlert, type Alert } from '../lib/overlay.svelte';
  import { openUrl } from '../platform';

  let { alert }: { alert: Alert } = $props();
  const sheet = $derived(alert.actions.length > 2 || alert.selected !== undefined);

  function run(i: number): void {
    const a = alert.actions[i];
    closeAlert();
    a.run();
  }

  function openLink(url: string): void {
    closeAlert();
    void openUrl(url);
  }
</script>

<div class="scrim" role="presentation" onclick={closeAlert} transition:fade={{ duration: 180 }}></div>
{#if sheet}
  <div class="sheet" role="dialog" aria-modal="true" aria-label={alert.title} in:rise out:rise={{ duration: 240 }}>
    <span class="handle" aria-hidden="true"></span>
    <p class="eyebrow title">{alert.title}</p>
    {#if alert.message}<p class="footnote label-2 message">{alert.message}</p>{/if}
    <div class="rows">
      {#each alert.actions as a, i (i)}
        <button class="row" class:on={alert.selected === i} class:destructive={a.destructive} onclick={() => run(i)}>
          <span class="text">{a.label}</span>
          {#if alert.selected === i}<Check size={20} strokeWidth={2.4} aria-hidden="true" />{/if}
        </button>
      {/each}
      {#if alert.qr}<button class="row" onclick={() => openLink(alert.qr!)}><span class="text">{alert.qr}</span></button>{/if}
    </div>
  </div>
{:else}
  <div class="dialog" role="alertdialog" aria-modal="true" aria-label={alert.title} in:pop={{ start: 1.12 }} out:pop={{ start: 0.96, duration: 160 }}>
    <p class="title-3">{alert.title}</p>
    {#if alert.message}<p class="callout label-2 message">{alert.message}</p>{/if}
    <div class="buttons">
      {#each alert.actions as a, i (i)}
        <button class="pill" class:primary={i === 0 && !a.destructive} class:destructive={a.destructive} onclick={() => run(i)}>{a.label}</button>
      {/each}
    </div>
  </div>
{/if}

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
    max-height: 72%;
    display: flex;
    flex-direction: column;
    padding: 0 max(12px, var(--safe-right)) calc(var(--safe-bottom) + 10px) max(12px, var(--safe-left));
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--bg-elevated);
    z-index: 51;
  }
  .handle {
    align-self: center;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-4);
    margin: 10px 0 14px;
  }
  .title {
    padding: 0 12px 6px;
    color: var(--label-3);
  }
  .sheet .message {
    padding: 0 12px 8px;
    white-space: pre-line;
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
    gap: 12px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
    font-size: var(--fs-body);
  }
  .row:active {
    background: var(--fill-2);
  }
  .row.on {
    font-weight: 600;
  }
  .row.on :global(svg) {
    color: var(--accent);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .destructive {
    color: var(--red);
  }
  .dialog {
    position: absolute;
    left: 50%;
    top: 50%;
    width: min(380px, calc(100% - 40px));
    translate: -50% -50%;
    padding: 26px 24px 22px;
    border-radius: var(--r-xl);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-2);
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dialog .message {
    white-space: pre-line;
    line-height: 1.4;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 14px;
  }
  .buttons .pill {
    flex: 1;
  }
  .pill.destructive {
    color: var(--red);
  }
</style>
