import { Inject, Injectable, Logger } from '@nestjs/common';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { StorageObjectNotFoundError, type StorageDriver } from './storage-driver.interface.js';

/**
 * `STORAGE_DRIVER=local` (the default) — everything under `STORAGE_ROOT`,
 * exactly as `MediaService`/`PrivateFileStore` wrote it directly before
 * this abstraction existed. No `signedUrl()`: local mode always streams
 * through this API (`FilesController`, the two private-document routes),
 * never a redirect.
 */
@Injectable()
export class LocalStorageDriver implements StorageDriver {
  private readonly logger = new Logger(LocalStorageDriver.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async put(key: string, buffer: Buffer): Promise<void> {
    const resolved = this.resolve(key);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, buffer);
  }

  /** Resolves once the file is open, so a missing file rejects here (like S3) instead of failing later on the stream. */
  async getStream(key: string): Promise<Readable> {
    const stream = createReadStream(this.resolve(key));
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new StorageObjectNotFoundError(key) : err));
    });
    return stream;
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone
      this.logger.error(`Could not delete stored file ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** C30: STORAGE_ROOT exists (or can be created) and is writable — an access check, no probe file. */
  async healthCheck(): Promise<boolean> {
    try {
      await mkdir(this.env.STORAGE_ROOT, { recursive: true });
      await access(this.env.STORAGE_ROOT, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Guards against path traversal — `key` always originates from this
   * driver's own callers (built from a `randomUUID()`, never user input
   * directly), but resolving it is still done defensively rather than
   * trusting a round-trip through the database.
   */
  private resolve(key: string): string {
    const root = path.resolve(this.env.STORAGE_ROOT);
    const resolved = path.resolve(root, key);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'Invalid storage key');
    }
    return resolved;
  }
}
