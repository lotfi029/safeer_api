import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { PUBLIC_STORAGE_DRIVER, type StorageDriver } from './storage-driver.interface.js';
import { LocalStorageDriver } from './local-storage.driver.js';
import { S3StorageDriver } from './s3-storage.driver.js';

/**
 * Storage abstraction (decision 3, safeer-backend-fix-prompt.md).
 * `STORAGE_DRIVER=local` (default) binds the token to `LocalStorageDriver`
 * (everything under `STORAGE_ROOT`); `s3` binds it to an `S3StorageDriver`
 * on `S3_BUCKET_PUBLIC`.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PUBLIC_STORAGE_DRIVER,
      useFactory: (env: Env, local: LocalStorageDriver): StorageDriver => (env.STORAGE_DRIVER === 's3' ? new S3StorageDriver(env) : local),
      inject: [ENV, LocalStorageDriver],
    },
    LocalStorageDriver,
  ],
  exports: [PUBLIC_STORAGE_DRIVER],
})
export class StorageModule {}
