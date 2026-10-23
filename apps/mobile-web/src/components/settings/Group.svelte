<script lang="ts">
  // A settings group (Android Group with its Eyebrow): a small caps title, rounded rows on the elevated fill, a hint
  // under them.
  import type { Snippet } from 'svelte';

  let { title, hint, children }: { title?: string; hint?: string; children: Snippet } = $props();
</script>

<section class="group">
  {#if title}<h2 class="footnote label-2 title">{title}</h2>{/if}
  <div class="rows">{@render children()}</div>
  {#if hint}<p class="footnote label-2 hint">{hint}</p>{/if}
</section>

<style>
  .group {
    margin: 26px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .title {
    text-transform: uppercase;
    font-size: calc(11px * var(--text-scale));
    font-weight: 650;
    letter-spacing: 0.06em;
    color: var(--label-3);
    margin: 0 0 8px 16px;
  }
  .rows {
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .rows > :global(* + *) {
    border-top: 0.5px solid var(--separator);
  }
  .hint {
    margin: 7px 16px 0;
    line-height: 1.35;
  }
</style>
