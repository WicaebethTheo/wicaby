// The desktop renderer's router, for the admin sections: back is this app's back. A deleted title leaves its own
// page; deleted from a card elsewhere, the page under stays.
import { adminTarget } from '../lib/item-menu.svelte';
import { handleBack, stack } from '../lib/nav.svelte';

export function back(): void {
  const top = stack[stack.length - 1]?.route;
  if (top?.name === 'detail' && top.id === adminTarget) handleBack();
}
