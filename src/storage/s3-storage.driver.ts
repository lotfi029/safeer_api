import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import type { StorageDriver } from './storage-driver.interface.js';

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
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
    // The SDK v3 types this as a union covering browser/React Native
    // bodies too; under Node it is always a Readable.
    return result.Body as Readable;
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
    } catch {
      // Already gone, or never written — not fatal to the delete itself, same as the local driver.
    }
  }

  async signedUrl(key: string, ttlSeconds = this.env.S3_SIGNED_URL_TTL_SECONDS): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}
