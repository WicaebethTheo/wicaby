<script lang="ts">
  // One settings row (Android GroupRow): an optional icon on its colour tile, a label with an optional line under it
  // and, on the right, the chosen value with a chevron (a choice or a page), a switch (a toggle, Safari's native one:
  // it gives the iOS haptic), or nothing (an action, red when destructive).
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { Component } from 'svelte';

  let {
    label,
    sub,
    icon,
    tint = 'var(--fill-3)',
    chevron = false,
    value,
    checked,
    destructive = false,
    accent = false,
    onclick,
    ontoggle,
  }: {
    label: string;
    sub?: string;
    icon?: Component;
    tint?: string;
    chevron?: boolean;
    value?: string;
    checked?: boolean;
    destructive?: boolean;
    accent?: boolean;
    onclick?: () => void;
    ontoggle?: (on: boolean) => void;
  } = $props();
</script>

{#if ontoggle}
  <label class="row">
    {@render lead()}
    <input class="switch" type="checkbox" switch checked={checked} onchange={(e) => ontoggle((e.currentTarget as HTMLInputElement).checked)} />
  </label>
{:else}
  <button class="row" class:destructive class:accent {onclick} disabled={!onclick}>
    {@render lead()}
    {#if value !== undefined}<span class="value label-2">{value}</span>{/if}
    {#if (value !== undefined || chevron) && onclick}<ChevronRight size={18} strokeWidth={2.2} aria-hidden="true" />{/if}
  </button>
{/if}

{#snippet lead()}
  {#if icon}
    {@const Icon = icon}
    <span class="tile" style:background={tint}><Icon size={18} strokeWidth={2.1} aria-hidden="true" /></span>
  {/if}
  <span class="label">
    <span class="text">{label}</span>
    {#if sub}<span class="footnote label-2 sub">{sub}</span>{/if}
  </span>
{/snippet}

<style>
  .row {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 16px;
    text-align: left;
    color: var(--label);
  }
  button.row:active:not(:disabled) {
    background: var(--fill-2);
  }
  .label {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    flex: none;
  }
  .row .tile :global(svg) {
    color: #fff;
  }
  .value {
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .row :global(svg) {
    color: var(--label-3);
    flex: none;
  }
  .destructive {
    color: var(--red);
  }
  .accent {
    color: var(--accent);
  }
  /* Safari 17.4+ draws the native switch; the accent tints it on. */
  .switch {
    flex: none;
    margin: 0;
    accent-color: var(--green);
    width: 51px;
    height: 31px;
  }
</style>
