import type { Readable } from 'node:stream';

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

/**
 * Storage abstraction (decision 3, safeer-backend-fix-prompt.md): the
 * public media pipeline (`MediaService`) goes through this instead of
 * calling `node:fs` directly, so `STORAGE_DRIVER=local|s3` (config/env.ts)
 * swaps the backing store with no change to the service's own logic
 * (checksums, variants, MIME allow-lists — none of that lives here).
 *
 * `key` is always a relative path built by the caller
 * (`assets/2026/09/<uuid>.jpg`) — the same shape `storage_key` columns store.
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

}
