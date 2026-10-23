// Lines of facts under a title, as the desktop's hero and item page write them.
import type { BaseItem } from '$shared/models';
import { runtimeText } from '$tv/format';
import { t } from '$tv/i18n.svelte';

const TYPES: Record<string, string> = { Movie: 'web_type_movie', Series: 'web_type_series', Episode: 'web_type_episode' };

// "FILM · ANIMATION, FANTASTIQUE" (shown in small caps).
export function eyebrowLine(item: BaseItem): string {
  const type = TYPES[item.Type ?? ''];
  return [type ? t(type) : undefined, item.Genres?.slice(0, 2).join(', ') || undefined].filter(Boolean).join(' · ');
}

// "2019 · 8 min · ★ 7,6" (the official rating and badges go in chips).
export function metaLine(item: BaseItem): string {
  const rating = item.CommunityRating != null ? `★ ${item.CommunityRating.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : undefined;
  return [item.ProductionYear?.toString(), item.Type === 'Series' ? undefined : runtimeText(item.RunTimeTicks), rating].filter(Boolean).join(' · ');
}

// The end of a playback started now: "Fin à 21:34".
export function endsAt(leftMs: number, rate = 1): string {
  const end = new Date(Date.now() + leftMs / Math.max(0.1, rate));
  return t('ends_at', end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
}
