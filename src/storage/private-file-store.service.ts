import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

export const MAX_PRIVATE_FILE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export interface PrivateFileStoreResult {
  storageKey: string;
  mime: string;
  sizeBytes: number;
  checksum: string;
}

/**
 * Storage for student application documents (Safeer infra change §3) —
 * completely separate from MediaService/media_assets. Files land at
 * `STORAGE_ROOT/private/applications/<applicationId>/<uuid>.<ext>` and are
 * never recorded in `media_assets`, so the public `/files/:publicId`
 * controller can never serve one, no matter who is signed in: only a
 * role-checked admin route or the owning applicant's own portal route
 * (wired up in a later phase) may stream one, and only with
 * `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
 *
 * Unlike MediaService.upload(), there is deliberately no webp/variant
 * pipeline here — a rejection letter or ID scan is stored and served
 * byte-for-byte as uploaded, once, to the reviewer or the applicant, never
 * resized for public display.
 */
@Injectable()
export class PrivateFileStore {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * Same ordering discipline as MediaService.upload() (magic-byte sniff →
   * allow-list → size cap → checksum → write), minus dedup-by-checksum:
   * two different applicants — or the same applicant re-uploading a
   * corrected copy — legitimately produce the same bytes, and unlike public
   * media there is no shared library to dedup into; every upload gets its
   * own row and its own file.
   */
  async store(buffer: Buffer, originalName: string, applicationId: string): Promise<PrivateFileStoreResult> {
    if (buffer.length > MAX_PRIVATE_FILE_BYTES) {
      throw new ProblemException(
        400,
        ErrorCode.VALIDATION_FAILED,
        `File exceeds the ${MAX_PRIVATE_FILE_BYTES / (1024 * 1024)} MB limit`,
      );
    }

    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_MIME.has(detected.mime)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'Only PDF, JPEG and PNG files are accepted');
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');

    const dir = path.posix.join('private', 'applications', applicationId);
    const storageKey = path.posix.join(dir, `${randomUUID()}.${detected.ext}`);

    await mkdir(this.resolveDir(dir), { recursive: true });
    await writeFile(this.resolvePath(storageKey), buffer);

    return {
      storageKey,
      mime: detected.mime,
      sizeBytes: buffer.length,
      checksum,
    };
  }

  /**
   * Joins `storageKey` under STORAGE_ROOT and guards against path
   * traversal — `storageKey` always originates from this service's own
   * `store()` and is persisted verbatim in `application_documents.storage_key`,
   * but resolving it is still done defensively rather than trusting the
   * database round-trip: the resolved path must stay inside STORAGE_ROOT.
   */
  resolvePath(storageKey: string): string {
    const root = path.resolve(this.env.STORAGE_ROOT);
    const resolved = path.resolve(root, storageKey);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'Invalid storage key');
    }
    return resolved;
  }

  private resolveDir(dir: string): string {
    return this.resolvePath(dir);
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolvePath(storageKey));
    } catch {
      // Already gone, or never written — not fatal to the delete itself.
    }
  }
}
