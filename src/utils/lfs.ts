import { requestUrl } from 'obsidian';
import { Logger, LogLevel } from './logger';
import { getErrorMessage } from './error';

/** LFS pointer: oid is 64-hex sha256 without the "sha256:" prefix */
export interface LfsPointer {
  oid: string;
  size: number;
}

export interface LfsObjectRef {
  oid: string;
  size: number;
}

export interface LfsTransferAction {
  href: string;
  header?: Record<string, string>;
}

export interface LfsBatchObject {
  oid: string;
  size: number;
  actions?: {
    upload?: LfsTransferAction;
    download?: LfsTransferAction;
    verify?: LfsTransferAction;
  };
  error?: { code: number; message: string };
}

const POINTER_VERSION = 'version https://git-lfs.github.com/spec/v1';
const POINTER_MAX_BYTES = 1024;
const OID_RE = /^[0-9a-f]{64}$/;

/** Below this, one GET is cheaper than several Range handshakes. */
const SINGLE_GET_MAX = 512 * 1024;
/** Aim for this many Range chunks — enough parallelism, few round-trips. */
const TARGET_CHUNKS = 8;
/**
 * Floor. `requestUrl` buffers a whole response, so a request that dies at 90%
 * loses everything: on slow links short chunks are cheaper than long retries.
 */
const MIN_CHUNK = 256 * 1024;
/** Ceiling: caps how much work one failed request can lose. */
const MAX_CHUNK = 4 * 1024 * 1024;
/** Parallel Range requests per object (file-level downloads are serialized). */
const CHUNK_CONCURRENCY = 3;
/** Extra parallelism once an object is split into many chunks. */
const CHUNK_CONCURRENCY_LARGE = 4;
/** Attempts per request — slow/lossy links need patience, not speed. */
const TRANSFER_ATTEMPTS = 4;
/** Base backoff; grows as `base * 2^attempt`. */
const RETRY_BASE_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Range-chunk size derived from the object's total size. A pure function of
 * `size` so retries and resumes agree on the on-disk `.part` layout.
 *
 * Mid-size objects get finer chunks (earlier first saved part); very large
 * objects get bigger chunks to avoid a request storm on high-latency links.
 */
export function lfsChunkSizeFor(size: number): number {
  if (size <= SINGLE_GET_MAX) return size;
  const raw = Math.ceil(size / TARGET_CHUNKS);
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, raw));
}

/** Thrown when the transfer endpoint ignores `Range` — fall back to a single GET. */
class RangeNotSupportedError extends Error {
  constructor() {
    super('LFS transfer endpoint does not support HTTP Range');
    this.name = 'RangeNotSupportedError';
  }
}

/** Map with at most `limit` concurrent invocations. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Optional persistent store for partially-downloaded LFS chunks. When present,
 * a failed download resumes from the saved parts on the next attempt.
 */
export interface LfsPartStore {
  readPart(oid: string, index: number): Promise<ArrayBuffer | null>;
  writePart(oid: string, index: number, data: ArrayBuffer): Promise<void>;
  clearParts(oid: string): Promise<void>;
}

/**
 * Strict LFS pointer parser: exactly 3 lines, whole text <= 1024 bytes.
 * Returns null for anything that is not a v1 pointer.
 */
export function parseLfsPointer(text: string): LfsPointer | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > POINTER_MAX_BYTES) {
    return null;
  }
  // Normalize line endings; allow a single trailing newline
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== 3) return null;
  if (lines[0] !== POINTER_VERSION) return null;

  const oidLine = lines[1];
  if (!oidLine.startsWith('oid sha256:')) return null;
  const oid = oidLine.slice('oid sha256:'.length);
  if (!OID_RE.test(oid)) return null;

  const sizeLine = lines[2];
  if (!sizeLine.startsWith('size ')) return null;
  const sizeStr = sizeLine.slice('size '.length);
  if (!/^\d+$/.test(sizeStr)) return null;

  return { oid, size: parseInt(sizeStr, 10) };
}

/** Exact pointer text (always ends with a newline). */
export function formatLfsPointer(oid: string, size: number): string {
  return `${POINTER_VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}

export function isLfsPointerText(text: string): boolean {
  return parseLfsPointer(text) !== null;
}

/** Lowercase hex sha256 of raw bytes (or UTF-8 bytes of a string). */
export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

interface LfsBatchRequest {
  operation: 'upload' | 'download';
  transfers: string[];
  objects: LfsObjectRef[];
  hash_algo: string;
}

/**
 * GitHub Git LFS client (Batch API + basic transfer adapter).
 *
 * Transfer PUT/GET use ONLY the headers returned by the batch call — never the
 * GitHub token — because hrefs are typically pre-signed object-storage URLs.
 */
export class GitHubLfsClient {
  private endpoint: string;
  private authHeader: string;
  private debug: boolean;
  private logger: Logger;
  private store?: LfsPartStore;
  /** Serializes whole-object downloads so chunk parallelism stays bounded. */
  private downloadChain: Promise<unknown> = Promise.resolve();

  /** `endpoint` = `https://github.com/{owner}/{repo}.git/info/lfs` (no trailing slash). */
  constructor(endpoint: string, token: string, debug: boolean = false, store?: LfsPartStore) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.authHeader = `Basic ${btoa(`x-access-token:${token}`)}`;
    this.debug = debug;
    this.logger = new Logger('LfsClient', debug ? LogLevel.DEBUG : LogLevel.INFO);
    this.store = store;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      this.logger.info(...args);
    }
  }

  async batch(operation: 'upload' | 'download', objects: LfsObjectRef[]): Promise<LfsBatchObject[]> {
    const body: LfsBatchRequest = {
      operation,
      transfers: ['basic'],
      objects: objects.map(o => ({ oid: o.oid, size: o.size })),
      hash_algo: 'sha256',
    };

    this.log(`batch ${operation}:`, objects.map(o => `${o.oid.substring(0, 8)} (${o.size}B)`));

    const response = await requestUrl({
      url: `${this.endpoint}/objects/batch`,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`LFS batch ${operation} failed with status ${response.status}: ${response.text?.substring(0, 200)}`);
    }

    const json = response.json as { objects?: LfsBatchObject[] };
    if (!json?.objects || !Array.isArray(json.objects)) {
      throw new Error(`LFS batch ${operation} returned no objects`);
    }
    return json.objects;
  }

  /**
   * Upload one object: batch upload, then PUT bytes to actions.upload.href.
   * Skips the PUT when the server already has the object (no actions.upload).
   * Posts to actions.verify when present.
   */
  async upload(oid: string, size: number, data: ArrayBuffer): Promise<void> {
    if (data.byteLength !== size) {
      throw new Error(`LFS upload size mismatch for ${oid}: expected ${size}, got ${data.byteLength}`);
    }
    const computed = await sha256Hex(data);
    if (computed !== oid) {
      throw new Error(`LFS upload hash mismatch: expected ${oid}, got ${computed}`);
    }

    const results = await this.batch('upload', [{ oid, size }]);
    const obj = results.find(r => r.oid === oid);
    if (!obj) {
      throw new Error(`LFS upload: object ${oid} missing from batch response`);
    }
    if (obj.error) {
      throw new Error(`LFS upload error for ${oid}: ${obj.error.message}`);
    }

    const uploadAction = obj.actions?.upload;
    if (uploadAction) {
      await this.transfer('PUT', uploadAction, data, oid);
      this.log(`uploaded ${oid.substring(0, 8)} (${size}B)`);
    } else {
      this.log(`object ${oid.substring(0, 8)} already on server, skipping PUT`);
    }

    const verifyAction = obj.actions?.verify;
    if (verifyAction) {
      await this.verify(verifyAction, oid, size);
    }
  }

  /**
   * Download one object via batch download + GET. Verifies sha256 and size.
   * Large objects are fetched as parallel HTTP Range chunks; when a part store
   * is configured the download resumes from surviving chunks after a failure.
   * Throws on integrity mismatch — never returns corrupt bytes.
   */
  async download(oid: string, size: number): Promise<ArrayBuffer> {
    const run = () => this.downloadUnqueued(oid, size);
    const p = this.downloadChain.then(run, run);
    this.downloadChain = p.catch(() => undefined);
    return p;
  }

  private async downloadUnqueued(oid: string, size: number): Promise<ArrayBuffer> {
    const results = await this.batch('download', [{ oid, size }]);
    const obj = results.find(r => r.oid === oid);
    if (!obj) {
      throw new Error(`LFS download: object ${oid} missing from batch response`);
    }
    if (obj.error) {
      throw new Error(`LFS download error for ${oid}: ${obj.error.message}`);
    }

    const downloadAction = obj.actions?.download;
    if (!downloadAction) {
      throw new Error(`LFS download: no download action for ${oid}`);
    }

    const chunkSize = lfsChunkSizeFor(size);
    const data = chunkSize < size
      ? await this.downloadChunked(downloadAction, oid, size, chunkSize)
      : await this.transfer('GET', downloadAction, undefined, oid);

    if (data.byteLength !== size) {
      throw new Error(`LFS integrity check failed for ${oid}: size mismatch (expected ${size}, got ${data.byteLength})`);
    }
    const computed = await sha256Hex(data);
    if (computed !== oid) {
      // Corrupt bytes must not resume from stale parts
      await this.store?.clearParts(oid);
      throw new Error(`LFS integrity check failed for ${oid}: hash mismatch (got ${computed})`);
    }
    await this.store?.clearParts(oid);
    this.log(`downloaded ${oid.substring(0, 8)} (${size}B)`);
    return data;
  }

  private expectedChunkSize(index: number, size: number, chunkSize: number): number {
    const start = index * chunkSize;
    return Math.min(chunkSize, size - start);
  }

  /**
   * Parallel Range download. Falls back to a single GET when the endpoint
   * returns 200 for a ranged request (Range unsupported). If the parallel wave
   * fails on a flaky link (HTTP/2 resets are common on slow routes), the
   * surviving parts are kept and the rest is fetched one chunk at a time.
   */
  private async downloadChunked(action: LfsTransferAction, oid: string, size: number, chunkSize: number): Promise<ArrayBuffer> {
    const totalChunks = Math.ceil(size / chunkSize);
    const concurrency = totalChunks > 8 ? CHUNK_CONCURRENCY_LARGE : CHUNK_CONCURRENCY;
    this.log(
      `chunked download ${oid.substring(0, 8)}: ${totalChunks} × ${Math.round(chunkSize / 1024)}KB, concurrency ${concurrency}`
    );
    const chunks = new Array<ArrayBuffer | null>(totalChunks).fill(null);

    // Resume: keep any part whose byte length matches the expected chunk
    if (this.store) {
      for (let i = 0; i < totalChunks; i++) {
        const saved = await this.store.readPart(oid, i);
        if (saved && saved.byteLength === this.expectedChunkSize(i, size, chunkSize)) {
          chunks[i] = saved;
        }
      }
      const reused = chunks.filter(c => c !== null).length;
      if (reused > 0) {
        this.log(`resuming ${oid.substring(0, 8)}: ${reused}/${totalChunks} chunks already on disk`);
      }
    }

    const missingOf = (): number[] => {
      const missing: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (chunks[i] === null) missing.push(i);
      }
      return missing;
    };

    const fetchChunk = async (i: number): Promise<void> => {
      const start = i * chunkSize;
      const end = start + this.expectedChunkSize(i, size, chunkSize) - 1;
      const part = await this.rangeGet(action, start, end, oid);
      chunks[i] = part;
      if (this.store) {
        await this.store.writePart(oid, i, part);
      }
    };

    // Returns null on success, or the error that stopped the wave.
    const runWave = async (indices: number[], limit: number): Promise<Error | null> => {
      try {
        await mapLimit(indices, limit, fetchChunk);
        return null;
      } catch (e) {
        return e instanceof Error ? e : new Error(getErrorMessage(e));
      }
    };

    let err = await runWave(missingOf(), concurrency);
    if (err && !(err instanceof RangeNotSupportedError)) {
      const remaining = missingOf();
      if (remaining.length > 0) {
        this.log(
          `parallel wave failed for ${oid.substring(0, 8)} (${getErrorMessage(err)}); ` +
          `retrying ${remaining.length} chunk(s) sequentially`
        );
        err = await runWave(remaining, 1);
      }
    }
    if (err instanceof RangeNotSupportedError) {
      this.log(`Range unsupported for ${oid.substring(0, 8)}, falling back to single GET`);
      await this.store?.clearParts(oid);
      return this.transfer('GET', action, undefined, oid);
    }
    if (err) throw err;

    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      if (!part) {
        throw new Error(`LFS chunked download incomplete for ${oid.substring(0, 8)}`);
      }
      out.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return out.buffer;
  }

  /** One Range GET. Retries on network failure / 5xx with exponential backoff. */
  private async rangeGet(
    action: LfsTransferAction,
    start: number,
    end: number,
    oid: string
  ): Promise<ArrayBuffer> {
    const expected = end - start + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt++) {
      try {
        const response = await requestUrl({
          url: action.href,
          method: 'GET',
          headers: {
            'Accept': 'application/vnd.git-lfs',
            'Range': `bytes=${start}-${end}`,
            ...(action.header ?? {}),
          },
          throw: false,
        });

        if (response.status === 206) {
          const buf = response.arrayBuffer ?? new ArrayBuffer(0);
          if (buf.byteLength !== expected) {
            throw new Error(
              `LFS range ${start}-${end} size mismatch for ${oid.substring(0, 8)}: expected ${expected}, got ${buf.byteLength}`
            );
          }
          return buf;
        }
        if (response.status === 200) {
          throw new RangeNotSupportedError();
        }
        lastError = new Error(
          `LFS range GET failed with status ${response.status} for ${oid.substring(0, 8)} (${start}-${end})`
        );
        // 5xx retryable; 416/other 4xx are not
        if (response.status < 500) throw lastError;
      } catch (err) {
        if (err instanceof RangeNotSupportedError) throw err;
        lastError = err instanceof Error ? err : new Error(getErrorMessage(err));
        if (attempt === TRANSFER_ATTEMPTS - 1) throw lastError;
      }
      const wait = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.log(`LFS range retry ${attempt + 1} in ${wait}ms for ${oid.substring(0, 8)} (${start}-${end})`);
      await delay(wait);
    }
    throw lastError ?? new Error(`LFS range GET failed for ${oid}`);
  }

  /** Basic transfer adapter. Retries on network failure / 5xx with backoff. */
  private async transfer(
    method: 'PUT' | 'GET',
    action: LfsTransferAction,
    body: ArrayBuffer | undefined,
    oid: string
  ): Promise<ArrayBuffer> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt++) {
      try {
        const response = await requestUrl({
          url: action.href,
          method,
          headers: {
            'Accept': 'application/vnd.git-lfs',
            'Content-Type': 'application/vnd.git-lfs',
            ...(action.header ?? {}),
          },
          body,
          throw: false,
        });

        if (response.status >= 200 && response.status < 300) {
          return response.arrayBuffer ?? new ArrayBuffer(0);
        }
        // 5xx is retryable; 4xx is not
        lastError = new Error(`LFS ${method} failed with status ${response.status} for ${oid.substring(0, 8)}`);
        if (response.status < 500) {
          throw lastError;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(getErrorMessage(err));
        if (attempt === TRANSFER_ATTEMPTS - 1) throw lastError;
      }
      const wait = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.log(`LFS ${method} retry ${attempt + 1} in ${wait}ms for ${oid.substring(0, 8)}`);
      await delay(wait);
    }
    throw lastError ?? new Error(`LFS ${method} failed for ${oid}`);
  }

  private async verify(action: LfsTransferAction, oid: string, size: number): Promise<void> {
    try {
      const response = await requestUrl({
        url: action.href,
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.git-lfs+json',
          'Content-Type': 'application/vnd.git-lfs+json',
          ...(action.header ?? {}),
        },
        body: JSON.stringify({ oid, size }),
        throw: false,
      });
      if (response.status >= 400) {
        throw new Error(`LFS verify failed with status ${response.status}`);
      }
      this.log(`verified ${oid.substring(0, 8)}`);
    } catch (err) {
      throw new Error(`LFS verify failed for ${oid}: ${getErrorMessage(err)}`);
    }
  }
}
