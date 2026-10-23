// Safari 17.4's native switch (<input type="checkbox" switch>), not yet in Svelte's element types.
import 'svelte/elements';

declare module 'svelte/elements' {
  interface HTMLInputAttributes {
    switch?: boolean;
  }
}
