import { Inject, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { StorageDriver } from './storage-driver.interface.js';

/**
 * `STORAGE_DRIVER=local` (the default) — everything under `STORAGE_ROOT`,
 * exactly as `MediaService`/`PrivateFileStore` wrote it directly before
 * this abstraction existed. No `signedUrl()`: local mode always streams
 * through this API (`FilesController`, the two private-document routes),
 * never a redirect.
 */
@Injectable()
export class LocalStorageDriver implements StorageDriver {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async put(key: string, buffer: Buffer): Promise<void> {
    const resolved = this.resolve(key);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, buffer);
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      // Already gone, or never written — not fatal to the delete itself.
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
