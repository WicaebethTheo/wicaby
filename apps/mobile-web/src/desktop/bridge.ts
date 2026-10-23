// The desktop renderer's `w` (window.wicaby, the Electron preload) for the admin sections it reuses: its api calls
// go straight to the server through this app's clients, its server events are the session socket's messages.
// Only what renderer/admin calls is here; anything else is a bug the type checker reports.
import type { Query } from '$shared/contract';
import { ApiError, type Api } from '$tv/api';
import { deviceId } from '$tv/identity';
import { onSocket } from '$tv/server-socket';
import { api as primary, apiOf } from '$tv/session.svelte';

function client(serverId?: string): Api {
  const a = apiOf(serverId) ?? primary();
  if (!a) throw new ApiError('not signed in', 401);
  return a;
}

// Main's api proxy keeps the status in the message (renderer code reads "HTTP 404" back from it).
async function call<T>(method: string, path: string, query: Query | undefined, body: unknown, serverId?: string): Promise<T> {
  try {
    return await client(serverId).request<T>(method, path, query, body);
  } catch (err) {
    if (err instanceof ApiError && err.status > 0 && !/\bHTTP \d{3}\b/.test(err.message)) throw new ApiError(`${err.message} (HTTP ${err.status})`, err.status);
    throw err;
  }
}

// Emby and Jellyfin take an image upload as its base64 text, with the image's own type (main/admin/item-images.ts).
async function uploadImage(itemId: string, type: string, mime: string, data: Uint8Array, serverId?: string): Promise<void> {
  const a = client(serverId);
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  const res = await fetch(a.url(`/Items/${itemId}/Images/${type}`), { method: 'POST', headers: { ...a.authHeaders(), 'Content-Type': mime }, body: btoa(bin) });
  if (!res.ok) throw new ApiError(`${(await res.text().catch(() => '')).slice(0, 300) || 'upload failed'} (HTTP ${res.status})`, res.status);
}

export const w = {
  api: {
    get: <T = unknown>(path: string, query?: Query, serverId?: string) => call<T>('GET', path, query, undefined, serverId),
    post: <T = unknown>(path: string, query?: Query, body?: unknown, serverId?: string) => call<T>('POST', path, query, body ?? {}, serverId),
    del: <T = unknown>(path: string, query?: Query, serverId?: string) => call<T>('DELETE', path, query, undefined, serverId),
    put: <T = unknown>(path: string, query?: Query, body?: unknown, serverId?: string) => call<T>('PUT', path, query, body ?? {}, serverId),
    uploadImage,
  },
  app: {
    info: () => Promise.resolve({ deviceId }),
    openExternal: (url: string) => void window.open(url, '_blank', 'noopener'),
  },
  events: {
    // The signed-in server's socket; its messages carry no server id, so they count for that server.
    onServerEvent: (cb: (ev: { type: string; data: unknown; serverId?: string }) => void) => onSocket((type, data) => cb({ type, data, serverId: primary()?.serverId })),
  },
};
