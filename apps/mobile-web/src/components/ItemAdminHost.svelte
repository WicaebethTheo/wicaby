<script lang="ts">
  // The desktop's item admin sheets (admin/item/ItemAdmin.svelte) over the pages, for the title and tool the menu
  // picked. Loaded with the first use: the admin's code and catalogs stay out of the app's first load.
  import { adminLanguage } from '../desktop/admin';
  import ItemAdmin from '../../../desktop/src/renderer/admin/item/ItemAdmin.svelte';
  import { closeItemAdmin, itemAdmin } from '../lib/item-menu.svelte';

  adminLanguage();
</script>

{#if itemAdmin.item}
  <ItemAdmin action={itemAdmin.action} item={itemAdmin.item} onclose={closeItemAdmin} />
{/if}
