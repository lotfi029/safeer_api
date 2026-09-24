import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PrivateFileStore } from './private-file-store.service.js';

/**
 * Private storage for student application documents (Safeer infra change
 * §3). Wired into the applications/portal document-upload endpoints in a
 * later phase; this phase only builds and registers the service.
 */
@Module({
  imports: [ConfigModule],
  providers: [PrivateFileStore],
  exports: [PrivateFileStore],
})
export class StorageModule {}
