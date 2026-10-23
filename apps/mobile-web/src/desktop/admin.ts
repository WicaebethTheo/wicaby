// What the desktop's admin sections need before they draw: the language this app shows, and server image URLs
// (main's wicaby-media://api on the desktop) at the server itself.
import { setMediaBase } from '$desktop/images';
import { setLanguage } from '$desktop/i18n.svelte';
import { apiOf } from '$tv/session.svelte';
import { settings } from '$tv/settings.svelte';
import '../../../desktop/src/renderer/admin/admin.css';
import './admin.css';

setMediaBase((serverId) => apiOf(serverId)?.url('') ?? '');

export function adminLanguage(): void {
  setLanguage(settings.language.value as 'auto' | 'fr' | 'en');
}
