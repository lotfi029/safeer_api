import type { Readable } from 'node:stream';

export interface SignedUrlOptions {
  ttlSeconds?: number;
  /** Returned as the response's Content-Type (S3 `ResponseContentType`). */
  contentType?: string;
  /** Returned as the response's Content-Disposition (S3 `ResponseContentDisposition`) — C19's RFC 5987 form. */
  contentDisposition?: string;
}

/**
 * Thrown by `getStream()` when `key` has no object — the same error from
 * either driver, so every caller can answer 404 without knowing whether
 * that was an ENOENT or an S3 NoSuchKey.
 */
export class StorageObjectNotFoundError extends Error {
  override readonly name = 'StorageObjectNotFoundError';
  constructor(readonly key: string) {
    super(`No stored object at ${key}`);
  }
}

/** `MediaService`'s driver — the public asset bucket in S3 mode. */
export const PUBLIC_STORAGE_DRIVER = Symbol('PUBLIC_STORAGE_DRIVER');
/** `PrivateFileStore`'s driver — the private document bucket in S3 mode. */
export const PRIVATE_STORAGE_DRIVER = Symbol('PRIVATE_STORAGE_DRIVER');

/**
 * Storage abstraction (decision 3, safeer-backend-fix-prompt.md): the
 * public media pipeline (`MediaService`) and applicants' private documents
 * (`PrivateFileStore`) both go through this instead of calling `node:fs`
 * directly, so `STORAGE_DRIVER=local|s3` (config/env.ts) swaps the backing
 * store with no change to either service's own logic (checksums, variants,
 * MIME allow-lists, ownership checks — none of that lives here).
 *
 * `key` is always a relative path built by the caller (`assets/2026/09/<uuid>.jpg`,
 * `private/applications/<id>/<uuid>.pdf`) — the same shape `storage_key`
 * columns already store, so no migration is needed to add this layer.
 */
export interface StorageDriver {
  /** Writes `buffer` at `key`, creating any intermediate directory (local) or the object (S3) as needed. */
  put(key: string, buffer: Buffer): Promise<void>;

  /** A readable stream of the object at `key` — piped straight into the HTTP response by the routes that stream bytes today. Rejects with `StorageObjectNotFoundError` if `key` doesn't exist. */
  getStream(key: string): Promise<Readable>;

  /**
   * Deletes the object at `key`. Never throws: callers remove files after
   * their database change has committed, where a throw would turn a
   * finished operation into a 500. A key that's already gone is a no-op;
   * any other failure (permissions, network) is logged, not swallowed
   * silently, so an orphaned file is visible.
   */
  remove(key: string): Promise<void>;

  /** Readiness (`GET /health/ready`): can this store be written to right now? Never throws. */
  healthCheck(): Promise<boolean>;

  /**
   * A short-lived, GET-only signed URL for `key` — S3 mode only (`local`
   * doesn't implement it; callers check `driver.signedUrl` before using it,
   * per decision 3: private documents in S3 mode get a signed URL instead
   * of being streamed through this API). `options.ttlSeconds` defaults to
   * `env.S3_SIGNED_URL_TTL_SECONDS`.
   */
  signedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
}
