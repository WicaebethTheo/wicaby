// The last errors the app met, kept on the phone (Settings > About lists them): a phone has no console to read, and
// an error while drawing a page can leave it half drawn. Uncaught errors, failed promises, and what a page's error
// boundary caught (reportError).
import { load, save } from '$tv/storage';

export interface LoggedError {
  at: string;
  where: string;
  message: string;
}

const KEY = 'errors';
const KEEP = 20;

export function reportError(where: string, error: unknown): void {
  const message = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack.split('\n').slice(0, 4).join('\n')}` : ''}` : String(error);
  const list = load<LoggedError[]>(KEY, []);
  save(KEY, [{ at: new Date().toISOString(), where, message: message.slice(0, 600) }, ...list].slice(0, KEEP));
}

export const loggedErrors = (): LoggedError[] => load<LoggedError[]>(KEY, []);
export const clearErrors = (): void => save(KEY, []);

export function initDiagnostics(): void {
  window.addEventListener('error', (e) => reportError('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));
}

// The items a keyed list may show: one per key, the first kept (a server can list a title, or a library, twice).
export function uniqueBy<T>(list: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
