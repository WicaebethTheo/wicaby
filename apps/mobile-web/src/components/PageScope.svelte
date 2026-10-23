<script lang="ts">
  // A page's stack key in its context, as the TV's Screen.svelte: onBack() handlers and the shared logic's
  // getContext(SCREEN) find the page they belong to.
  import { setContext, type Snippet } from 'svelte';
  import { SCREEN } from '../lib/nav.svelte';

  let { key, children }: { key: number; children: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  setContext(SCREEN, key);
</script>

{@render children()}
