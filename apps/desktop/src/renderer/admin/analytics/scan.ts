// Analytics scans over the IPC API proxy, and their cache. A scan pages through one library's items with
// the media fields; the result is kept per server and library in IndexedDB (a big library outgrows
// localStorage). Any IndexedDB failure leaves a memory-only cache for the session.
import type { ServerKind } from '../../../shared/contract';
import { scanQuery, toRow, type ScanRow } from '../../../shared/library-analytics';
import type { BaseItem } from '../../../shared/models';
import { w } from '../../lib/bridge';
import { sessionFor } from '../../lib/stores.svelte';

export interface CachedScan {
  at: string;
  rows: ScanRow[];
}

const PAGE = 300;

// alive() false between pages stops the scan (the page was left or the scope changed): null then.
export async function scanLibrary(serverId: string, kind: ServerKind, libId: string, progress: (done: number, total: number) => void, alive: () => boolean): Promise<ScanRow[] | null> {
  const uid = sessionFor(serverId)?.user?.id;
  if (!uid) throw new Error('HTTP 401');
  const rows: ScanRow[] = [];
  // A library that changes during the scan shifts the pages: an item met twice is counted once, and the end is
  // the server's offset, not the row count.
  const seen = new Set<string>();
  for (let start = 0; ; start += PAGE) {
    if (!alive()) return null;
    const q = scanQuery(libId, start, PAGE);
    const r =
      kind === 'jellyfin'
        ? await w.api.get<{ Items?: BaseItem[]; TotalRecordCount?: number }>('/Items', { ...q, userId: uid }, serverId)
        : await w.api.get<{ Items?: BaseItem[]; TotalRecordCount?: number }>(`/Users/${uid}/Items`, q, serverId);
    const items = r?.Items ?? [];
    for (const x of items) if (!seen.has(x.Id) && seen.add(x.Id)) rows.push(toRow(x, libId));
    const total = r?.TotalRecordCount ?? start + items.length;
    progress(Math.min(start + items.length, total), total);
    if (items.length < PAGE || start + items.length >= total) return alive() ? rows : null;
  }
}

// ---- Cache ----

const memory = new Map<string, CachedScan>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('wicaby-analytics', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('scans');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

const cacheKey = (serverId: string, libId: string) => `${serverId}/${libId}`;

export async function loadScan(serverId: string, libId: string): Promise<CachedScan | null> {
  const key = cacheKey(serverId, libId);
  if (memory.has(key)) return memory.get(key)!;
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction('scans').objectStore('scans').get(key);
      req.onsuccess = () => {
        const v = req.result as CachedScan | undefined;
        if (v) memory.set(key, v);
        resolve(v ?? null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveScan(serverId: string, libId: string, scan: CachedScan): Promise<void> {
  const key = cacheKey(serverId, libId);
  memory.set(key, scan);
  const d = await db();
  try {
    d?.transaction('scans', 'readwrite').objectStore('scans').put(scan, key);
  } catch {
    /* memory only (quota, private profile) */
  }
}
