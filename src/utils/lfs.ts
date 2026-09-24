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

  /** `endpoint` = `https://github.com/{owner}/{repo}.git/info/lfs` (no trailing slash). */
  constructor(endpoint: string, token: string, debug: boolean = false) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.authHeader = `Basic ${btoa(`x-access-token:${token}`)}`;
    this.debug = debug;
    this.logger = new Logger('LfsClient', debug ? LogLevel.DEBUG : LogLevel.INFO);
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
   * Throws on integrity mismatch — never returns corrupt bytes.
   */
  async download(oid: string, size: number): Promise<ArrayBuffer> {
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

    const data = await this.transfer('GET', downloadAction, undefined, oid);

    if (data.byteLength !== size) {
      throw new Error(`LFS integrity check failed for ${oid}: size mismatch (expected ${size}, got ${data.byteLength})`);
    }
    const computed = await sha256Hex(data);
    if (computed !== oid) {
      throw new Error(`LFS integrity check failed for ${oid}: hash mismatch (got ${computed})`);
    }
    this.log(`downloaded ${oid.substring(0, 8)} (${size}B)`);
    return data;
  }

  /** Basic transfer adapter. One retry on network failure / 5xx. */
  private async transfer(
    method: 'PUT' | 'GET',
    action: LfsTransferAction,
    body: ArrayBuffer | undefined,
    oid: string
  ): Promise<ArrayBuffer> {
    const maxAttempts = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        if (attempt === maxAttempts - 1) throw lastError;
      }
      this.log(`LFS ${method} retry ${attempt + 1} for ${oid.substring(0, 8)}`);
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
