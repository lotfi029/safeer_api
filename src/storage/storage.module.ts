import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { PrivateFileStore } from './private-file-store.service.js';
import { PUBLIC_STORAGE_DRIVER, PRIVATE_STORAGE_DRIVER, type StorageDriver } from './storage-driver.interface.js';
import { LocalStorageDriver } from './local-storage.driver.js';
import { S3StorageDriver } from './s3-storage.driver.js';

/**
 * Storage abstraction (decision 3, safeer-backend-fix-prompt.md).
 * `STORAGE_DRIVER=local` (default) binds both tokens to the same
 * `LocalStorageDriver` (bucket-agnostic — everything lives under
 * `STORAGE_ROOT`, namespaced by key prefix as it always was). `s3` binds
 * each to its own `S3StorageDriver` instance, one per bucket
 * (`S3_BUCKET_PUBLIC`/`S3_BUCKET_PRIVATE`).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    PrivateFileStore,
    {
      provide: PUBLIC_STORAGE_DRIVER,
      useFactory: (env: Env, local: LocalStorageDriver): StorageDriver =>
        env.STORAGE_DRIVER === 's3' ? new S3StorageDriver(env, 'public') : local,
      inject: [ENV, LocalStorageDriver],
    },
    {
      provide: PRIVATE_STORAGE_DRIVER,
      useFactory: (env: Env, local: LocalStorageDriver): StorageDriver =>
        env.STORAGE_DRIVER === 's3' ? new S3StorageDriver(env, 'private') : local,
      inject: [ENV, LocalStorageDriver],
    },
    LocalStorageDriver,
  ],
  exports: [PrivateFileStore, PUBLIC_STORAGE_DRIVER, PRIVATE_STORAGE_DRIVER],
})
export class StorageModule {}
