import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { StorageObjectNotFoundError, type StorageDriver } from './storage-driver.interface.js';

/**
 * `STORAGE_DRIVER=s3` — an S3-compatible object store (any provider that
 * speaks the S3 API: AWS itself, a self-hosted MinIO, etc. — `S3_ENDPOINT`
 * points at it), writing to `S3_BUCKET_PUBLIC` — see storage.module.ts.
 */
@Injectable()
export class S3StorageDriver implements StorageDriver {
  private readonly logger = new Logger(S3StorageDriver.name);
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(@Inject(ENV) env: Env) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
      // Most S3-compatible providers (MinIO, R2, ...) need path-style
      // addressing (`endpoint/bucket/key`) rather than AWS's own
      // virtual-hosted-style (`bucket.endpoint/key`) default.
      forcePathStyle: true,
    });
    this.bucketName = env.S3_BUCKET_PUBLIC!;
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
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
