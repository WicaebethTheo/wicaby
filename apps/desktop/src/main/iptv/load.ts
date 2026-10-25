// Loading an IPTV source (no Electron import, so iptv-check.mjs runs it under Node): the playlist read whole under a
// size cap, the XMLTV guide streamed through gunzip (gzip found by its magic bytes, whatever the URL says) into the
// streaming parser, which keeps only the playlist's channels inside the window. Every URL here is untrusted: only
// http(s), and local files only as paths main chose (the OS picker), never a file: URL from a playlist.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { collectGuide, type GuideProgramme } from '../../shared/iptv/guide';
import { isWebUrl, parseM3u, type Playlist } from '../../shared/iptv/m3u';

export const PLAYLIST_MAX_BYTES = 32 * 1024 * 1024;
export const GUIDE_MAX_BYTES = 200 * 1024 * 1024; // as transferred (gzip or not)
export const GUIDE_MAX_INFLATED = 1536 * 1024 * 1024;
export const PLAYLIST_TIMEOUT_MS = 30_000;
export const GUIDE_TIMEOUT_MS = 180_000;
export const IDLE_TIMEOUT_MS = 30_000;
export const GUIDE_PAST_MS = 6 * 3_600_000;
export const GUIDE_AHEAD_MS = 7 * 24 * 3_600_000;

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export class IptvLoadError extends Error {
  constructor(
    readonly code: 'invalid' | 'unreachable' | 'http' | 'tooBig' | 'timeout' | 'empty' | 'unsupported',
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

// The host a log line or the UI may show for a source address: never a path, a query or credentials.
export function hostOf(src: string): string {
  if (!isWebUrl(src)) return src.split(/[\\/]/).pop() ?? '';
  try {
    return new URL(src).host;
  } catch {
    return '';
  }
}

export const isLocalPath = (s: string): boolean => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(s) && !/[\0]/.test(s);

// Bytes of a source, as a Node stream, under a byte cap and an overall and idle deadline.
async function open(src: string, fetcher: Fetcher, maxBytes: number, timeoutMs: number): Promise<{ body: Readable; done: () => void }> {
  if (isLocalPath(src)) {
    const st = await fs.promises.stat(src).catch(() => null);
    if (!st?.isFile()) throw new IptvLoadError('unreachable', 'file not found');
    if (st.size > maxBytes) throw new IptvLoadError('tooBig', 'file too big');
    return { body: fs.createReadStream(src), done: () => undefined };
  }
  if (!isWebUrl(src)) throw new IptvLoadError('invalid', 'not an http(s) URL');
  const ctl = new AbortController();
  let reason: IptvLoadError | null = null;
  const fail = (e: IptvLoadError): void => {
    reason ??= e;
    ctl.abort();
  };
  const total = setTimeout(() => fail(new IptvLoadError('timeout', 'timeout')), timeoutMs);
  let idle = setTimeout(() => fail(new IptvLoadError('timeout', 'timeout')), IDLE_TIMEOUT_MS);
  const done = (): void => {
    clearTimeout(total);
    clearTimeout(idle);
  };
  let res: Response;
  try {
    res = await fetcher(src, { signal: ctl.signal, headers: { Accept: '*/*' } });
  } catch (err) {
    done();
    throw reason ?? new IptvLoadError('unreachable', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok || !res.body) {
    done();
    void res.body?.cancel().catch(() => undefined);
    throw new IptvLoadError('http', `HTTP ${res.status}`, res.status);
  }
  const length = Number(res.headers.get('content-length'));
  if (length > maxBytes) {
    done();
    void res.body.cancel().catch(() => undefined);
    throw new IptvLoadError('tooBig', 'too big');
  }
  let seen = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (c: Buffer) => {
    seen += c.length;
    clearTimeout(idle);
    idle = setTimeout(() => fail(new IptvLoadError('timeout', 'timeout')), IDLE_TIMEOUT_MS);
    if (seen > maxBytes) fail(new IptvLoadError('tooBig', 'too big'));
  });
  ctl.signal.addEventListener('abort', () => body.destroy(reason ?? new IptvLoadError('timeout', 'aborted')), { once: true });
  body.on('close', done);
  return { body, done };
}

// The bytes, inflated when they start with the gzip magic (1f 8b).
function maybeGunzip(body: Readable, maxInflated: number): Readable {
  const out = new Readable({ read() {} });
  let decided = false;
  let inflated = 0;
  const pass = (src: Readable): void => {
    src.on('data', (c: Buffer) => {
      inflated += c.length;
      if (inflated > maxInflated) {
        body.destroy();
        out.destroy(new IptvLoadError('tooBig', 'too big'));
        return;
      }
      out.push(c);
    });
    src.on('end', () => out.push(null));
    src.on('error', (e) => out.destroy(e));
  };
  body.once('data', (first: Buffer) => {
    decided = true;
    body.pause();
    if (first[0] === 0x1f && first[1] === 0x8b) {
      const gz = zlib.createGunzip();
      pass(gz);
      gz.write(first);
      body.pipe(gz);
    } else {
      pass(body);
      out.push(first);
      inflated += first.length;
    }
    body.resume();
  });
  body.on('error', (e) => out.destroy(e));
  body.on('end', () => !decided && out.push(null));
  return out;
}

export async function loadPlaylist(src: string, fetcher: Fetcher): Promise<Playlist> {
  const { body } = await open(src, fetcher, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  for await (const c of maybeGunzip(body, PLAYLIST_MAX_BYTES)) chunks.push(c as Buffer);
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  const pl = parseM3u(text);
  // Streams there, but none in a scheme the players take: say so rather than "no channel".
  // Spaces and tabs only before the scheme: \s would cross newlines and a body of blank lines would take quadratic time.
  if (!pl.channels.length) throw new IptvLoadError(/^[ \t]*(?:rtmp\w*|rtp|udp|mms\w*|srt):\/\//im.test(text) ? 'unsupported' : 'empty', 'no channel');
  return pl;
}

export interface GuideResult {
  programmes: Map<string, GuideProgramme[]>;
  count: number;
  skipped: number;
  end: number | null; // last programme end
}

export async function loadGuide(src: string, pl: Playlist, fetcher: Fetcher, now = Date.now()): Promise<GuideResult> {
  const { body } = await open(src, fetcher, GUIDE_MAX_BYTES, GUIDE_TIMEOUT_MS);
  const c = collectGuide(pl.channels, now - GUIDE_PAST_MS, now + GUIDE_AHEAD_MS);
  const dec = new TextDecoder('utf-8');
  for await (const chunk of maybeGunzip(body, GUIDE_MAX_INFLATED)) c.parser.push(dec.decode(chunk as Buffer, { stream: true }));
  c.parser.push(dec.decode());
  const programmes = c.finish();
  let end: number | null = null;
  for (const l of programmes.values()) if (l.length) end = Math.max(end ?? 0, l[l.length - 1].stop);
  return { programmes, count: c.count(), skipped: c.parser.skipped, end };
}
