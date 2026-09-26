import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { Response } from 'express';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { PRIVATE_STORAGE_DRIVER, type StorageDriver } from './storage-driver.interface.js';
import { contentDisposition } from '../common/http/filenames.js';

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
 * `private/applications/<applicationId>/<uuid>.<ext>` under whichever
 * `PRIVATE_STORAGE_DRIVER` binds to (decision 3: local disk under
 * `STORAGE_ROOT`, or the S3 private bucket) and are never recorded in
 * `media_assets`, so the public `/files/:publicId` controller can never
 * serve one, no matter who is signed in: only a role-checked admin route
 * or the owning applicant's own portal route may reach `serve()` below.
 *
 * Unlike MediaService.upload(), there is deliberately no webp/variant
 * pipeline here — a rejection letter or ID scan is stored and served
 * byte-for-byte as uploaded, once, to the reviewer or the applicant, never
 * resized for public display.
 */
@Injectable()
export class PrivateFileStore {
  constructor(@Inject(PRIVATE_STORAGE_DRIVER) private readonly driver: StorageDriver) {}

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

    await this.driver.put(storageKey, buffer);

    return {
      storageKey,
      mime: detected.mime,
      sizeBytes: buffer.length,
      checksum,
    };
  }

  async remove(storageKey: string): Promise<void> {
    await this.driver.remove(storageKey);
  }

  /**
   * The single place both private-document routes (`portal/documents/:id/file`,
   * `admin/applications/:id/documents/:docId/file`) reach after their own
   * auth/ownership checks pass. Decision 3: in S3 mode (`driver.signedUrl`
   * is defined), a 302 to a short-lived signed GET URL — the private bucket
   * is never made public, so this redirect is the only way anything in it
   * is ever reachable from outside this process. In local mode, streamed
   * through this API exactly as before, with the same
   * `Cache-Control: private, no-store` / `X-Content-Type-Options: nosniff`
   * headers either way matters only for the streamed branch.
   */
  async serve(res: Response, doc: { storageKey: string; mime: string; originalName: string }): Promise<void> {
    const disposition = contentDisposition('inline', doc.originalName);
    if (this.driver.signedUrl) {
      const url = await this.driver.signedUrl(doc.storageKey, { contentType: doc.mime, contentDisposition: disposition });
      res.setHeader('Cache-Control', 'private, no-store');
      res.redirect(302, url);
      return;
    }

    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', disposition);

    const stream = await this.driver.getStream(doc.storageKey);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
  }
}
