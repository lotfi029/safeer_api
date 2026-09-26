import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { StorageObjectNotFoundError, type SignedUrlOptions, type StorageDriver } from './storage-driver.interface.js';

/** Which S3 bucket a given `S3StorageDriver` instance writes to — see storage.module.ts's two provider bindings. */
export type S3Bucket = 'public' | 'private';

/**
 * `STORAGE_DRIVER=s3` — an S3-compatible object store (any provider that
 * speaks the S3 API: AWS itself, a self-hosted MinIO, etc. — `S3_ENDPOINT`
 * points at it). One instance per bucket (`bucket` picks
 * `S3_BUCKET_PUBLIC`/`S3_BUCKET_PRIVATE` at construction) — see
 * storage.module.ts for the two DI bindings.
 *
 * The private bucket is never made public: `signedUrl()` is the only way
 * anything in it is ever reachable from outside this process, and it's
 * always short-lived (`S3_SIGNED_URL_TTL_SECONDS`, default 300s).
 */
@Injectable()
export class S3StorageDriver implements StorageDriver {
  private readonly logger = new Logger(S3StorageDriver.name);
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(
    @Inject(ENV) private readonly env: Env,
    bucket: S3Bucket,
  ) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
      // Most S3-compatible providers (MinIO, R2, ...) need path-style
      // addressing (`endpoint/bucket/key`) rather than AWS's own
      // virtual-hosted-style (`bucket.endpoint/key`) default.
      forcePathStyle: true,
    });
    this.bucketName = bucket === 'public' ? env.S3_BUCKET_PUBLIC! : env.S3_BUCKET_PRIVATE!;
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: buffer }));
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
      // The SDK v3 types this as a union covering browser/React Native
      // bodies too; under Node it is always a Readable.
      return result.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new StorageObjectNotFoundError(key);
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      // DeleteObject succeeds for a missing key, so any error here is real.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      this.logger.error(`Could not delete s3://${this.bucketName}/${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The bucket exists and these credentials can reach it (HeadBucket). */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      // C19: the signed download carries the same type and RFC 5987 filename
      // a streamed one would.
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.contentDisposition,
    });
    return getSignedUrl(this.client, command, { expiresIn: options.ttlSeconds ?? this.env.S3_SIGNED_URL_TTL_SECONDS });
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
