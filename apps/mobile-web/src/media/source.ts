// Byte sources for the demuxer: a file the server serves as is (HTTP Range requests: random access, no work on the
// server) or a stream it produces (a progressive conversion: read once, in order). Both are read through a Cursor,
// sequentially from an offset; a seek opens a new cursor where the file must be read.

export interface Cursor {
  // Absolute offset of the next byte.
  readonly offset: number;
  // Exactly n bytes, or fewer at the end of the data.
  read(n: number): Promise<Uint8Array>;
  skip(n: number): Promise<void>;
  close(): void;
}

export interface ByteSource {
  // The size in bytes, when known (a file); undefined for a stream.
  readonly size: number | undefined;
  readonly seekable: boolean;
  open(offset: number): Cursor;
}

// Range reads grow from 256 KB to 4 MB while the cursor reads on, and one chunk is fetched ahead, so the network
// stays busy without holding more than ~8 MB.
const FIRST_CHUNK = 256 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;

export class RangeSource implements ByteSource {
  readonly seekable = true;

  constructor(
    private readonly url: string,
    readonly size: number,
    private readonly headers: Record<string, string> = {},
  ) {}

  // The size from a one-byte probe (Content-Range), or from the server's metadata when the header is not exposed.
  static async probe(url: string, headers: Record<string, string> = {}, fallbackSize?: number): Promise<{ source: RangeSource; head: Uint8Array }> {
    const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-65535' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const head = new Uint8Array(await res.arrayBuffer());
    const range = res.headers.get('content-range');
    const total = range ? Number(range.split('/')[1]) : res.status === 200 ? head.length : NaN;
    let size = Number.isFinite(total) && total > 0 ? total : fallbackSize;
    // A server (or proxy) that does not expose Content-Range: the length of the whole file, from HEAD.
    if (!size) {
      const h = await fetch(url, { method: 'HEAD', headers });
      size = Number(h.headers.get('content-length')) || undefined;
    }
    if (!size) throw new Error('unknown size');
    return { source: new RangeSource(url, size, headers), head };
  }

  open(offset: number): Cursor {
    return new RangeCursor(this, offset);
  }

  async fetch(from: number, to: number, signal: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(this.url, { headers: { ...this.headers, Range: `bytes=${from}-${to - 1}` }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

class RangeCursor implements Cursor {
  private buf = new Uint8Array(0);
  private bufStart: number;
  private chunk = FIRST_CHUNK;
  private ahead: { from: number; data: Promise<Uint8Array> } | null = null;
  private readonly abort = new AbortController();
  offset: number;

  constructor(
    private readonly src: RangeSource,
    offset: number,
  ) {
    this.offset = offset;
    this.bufStart = offset;
  }

  private fetchAt(from: number): { from: number; data: Promise<Uint8Array> } {
    const to = Math.min(this.src.size, from + this.chunk);
    this.chunk = Math.min(MAX_CHUNK, this.chunk * 2);
    const data = this.src.fetch(from, to, this.abort.signal);
    data.catch(() => {});
    return { from, data };
  }

  // Makes [offset, offset + n) available in buf, fetching what is missing.
  private async fill(n: number): Promise<void> {
    while (this.bufStart + this.buf.length < Math.min(this.offset + n, this.src.size)) {
      const end = this.bufStart + this.buf.length;
      const next = this.ahead && this.ahead.from === end ? this.ahead : this.fetchAt(end);
      this.ahead = null;
      const data = await next.data;
      // Keep only what is still ahead of the cursor.
      const keep = this.buf.subarray(Math.max(0, this.offset - this.bufStart));
      const merged = new Uint8Array(keep.length + data.length);
      merged.set(keep);
      merged.set(data, keep.length);
      this.bufStart = end - keep.length;
      this.buf = merged;
      const after = this.bufStart + this.buf.length;
      if (after < this.src.size) this.ahead = this.fetchAt(after);
    }
  }

  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const at = this.offset - this.bufStart;
    const out = this.buf.slice(at, at + n);
    this.offset += out.length;
    return out;
  }

  async skip(n: number): Promise<void> {
    const target = this.offset + n;
    if (target <= this.bufStart + this.buf.length) {
      this.offset = target;
      return;
    }
    // Past what is held: jump, dropping the read-ahead.
    this.offset = target;
    this.bufStart = target;
    this.buf = new Uint8Array(0);
    this.ahead = null;
    this.chunk = FIRST_CHUNK;
  }

  close(): void {
    this.abort.abort();
  }
}

// A response body read in order (a conversion the server streams): no size, no seeking.
export class StreamSource implements ByteSource {
  readonly seekable = false;
  readonly size = undefined;
  private used = false;

  constructor(private readonly response: Response) {}

  open(offset: number): Cursor {
    if (this.used || offset !== 0) throw new Error('a stream is read once, from its start');
    this.used = true;
    return new StreamCursor(this.response.body!.getReader());
  }
}

class StreamCursor implements Cursor {
  private buf = new Uint8Array(0);
  private done = false;
  offset = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      const merged = new Uint8Array(this.buf.length + value.length);
      merged.set(this.buf);
      merged.set(value, this.buf.length);
      this.buf = merged;
    }
  }

  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(out.length);
    this.offset += out.length;
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(Math.min(left, 1 << 20));
      const k = Math.min(left, this.buf.length);
      if (k === 0) return;
      this.buf = this.buf.subarray(k);
      this.offset += k;
      left -= k;
    }
  }

  close(): void {
    void this.reader.cancel().catch(() => {});
  }
}

// A local buffer as a source (tests, and the Node check that feeds files).
export class BufferSource implements ByteSource {
  readonly seekable = true;
  constructor(private readonly data: Uint8Array) {}
  get size(): number {
    return this.data.length;
  }
  open(offset: number): Cursor {
    const data = this.data;
    return {
      offset,
      async read(n: number) {
        const out = data.slice(this.offset, this.offset + n);
        this.offset += out.length;
        return out;
      },
      async skip(n: number) {
        this.offset += n;
      },
      close() {},
    } as Cursor & { offset: number };
  }
}

// A file on the phone (a download): random access by slicing it, nothing read before it is asked for.
export class BlobSource implements ByteSource {
  readonly seekable = true;
  constructor(private readonly blob: Blob) {}
  get size(): number {
    return this.blob.size;
  }
  open(offset: number): Cursor {
    const blob = this.blob;
    return {
      offset,
      async read(n: number) {
        const out = new Uint8Array(await blob.slice(this.offset, this.offset + n).arrayBuffer());
        this.offset += out.length;
        return out;
      },
      async skip(n: number) {
        this.offset += n;
      },
      close() {},
    } as Cursor & { offset: number };
  }
}
