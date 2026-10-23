// A title's menu, from a long press on its card or its page's "…" (Emby's item context menu, the Android cards'
// onLongClick): one at a time over the pages, drawn by components/ItemMenu.svelte.
import type { BaseItem } from '$shared/models';
import type { SeriesDates } from '$desktop/continue';
import { apiOf } from '$tv/session.svelte';

export interface ItemMenuContext {
  // Opened from the Continue watching row: "Remove" hides the card (and the series' dates order the undo).
  continueRow?: SeriesDates;
  // The page it was opened on is this title's own: no "More info".
  onPage?: boolean;
}

export const itemMenu = $state<{ item: BaseItem | null; ctx: ItemMenuContext }>({ item: null, ctx: {} });

// The title as of now (watched, favourite, CanDelete, its files), read while the press is held (lib/press hold) so
// the menu opens with its final rows and does not grow under the finger.
export type MenuItem = BaseItem & { CanDelete?: boolean; Path?: string; ExternalUrls?: { Name: string; Url: string }[] };
const FIELDS = 'CanDelete,MediaSources,MediaStreams,Path,ProviderIds,ExternalUrls,DateCreated';
const fresh = new Map<string, Promise<MenuItem>>();
const ready = new Map<string, MenuItem>();

export function fetchMenuItem(item: BaseItem): Promise<MenuItem> {
  const c = apiOf(item.ServerId);
  if (!c) return Promise.resolve(item);
  let p = fresh.get(item.Id);
  if (!p) {
    const q = { Fields: FIELDS };
    p = (c.isEmby ? c.get<MenuItem>(`/Users/${c.userId}/Items/${item.Id}`, q) : c.get<MenuItem>(`/Items/${item.Id}`, { ...q, userId: c.userId })).then((it) => {
      const full = { ...item, ...it, ServerId: item.ServerId ?? c.serverId };
      ready.set(item.Id, full);
      return full;
    });
    p.catch(() => {}).finally(() => setTimeout(() => (fresh.delete(item.Id), ready.delete(item.Id)), 3000));
    fresh.set(item.Id, p);
  }
  return p;
}

export function openItemMenu(item: BaseItem, ctx: ItemMenuContext = {}): void {
  itemMenu.item = ready.get(item.Id) ?? item;
  itemMenu.ctx = ctx;
}

// A card's long press: the title is read while held, its menu opens on 480 ms.
export const menuPress = (item: BaseItem, ctx: ItemMenuContext = {}) => ({ run: () => openItemMenu(item, ctx), hold: () => void fetchMenuItem(item).catch(() => {}) });

export function closeItemMenu(): void {
  itemMenu.item = null;
}

// The administrator's tools on a title (the desktop's admin/item sheets: edit, identify, artwork, refresh, subtitles,
// delete), opened from the menu once it has closed; drawn by components/ItemAdminHost.svelte.
export type ItemAdminAction = 'edit' | 'identify' | 'images' | 'refresh' | 'subtitles' | 'delete';
export const itemAdmin = $state<{ item: BaseItem | null; action: ItemAdminAction | null }>({ item: null, action: null });
// The title the last sheet was about: a deletion leaves that title's page, and only that one.
export let adminTarget: string | null = null;

export function openItemAdmin(item: BaseItem, action: ItemAdminAction): void {
  adminTarget = item.Id;
  itemAdmin.item = item;
  itemAdmin.action = action;
}

export function closeItemAdmin(): void {
  itemAdmin.action = null;
}

// The desktop's adminEntries (admin/item/metadata.ts) without loading the admin: which tools a title has.
const IDENTIFIABLE = ['Movie', 'Series', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'Person', 'Book', 'MusicVideo', 'Trailer'];
const SUBTITLED = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'];
export function adminActions(item: BaseItem & { CanDelete?: boolean }): ItemAdminAction[] {
  if (item.Type === 'CollectionFolder' || item.Type === 'UserView') return [];
  const out: ItemAdminAction[] = ['edit'];
  if (IDENTIFIABLE.includes(item.Type ?? '')) out.push('identify');
  out.push('images', 'refresh');
  if (SUBTITLED.includes(item.Type ?? '') && item.MediaType === 'Video') out.push('subtitles');
  if (item.CanDelete) out.push('delete');
  return out;
}
