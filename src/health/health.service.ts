import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { PUBLIC_STORAGE_DRIVER, type StorageDriver } from '../storage/storage-driver.interface.js';

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PUBLIC_STORAGE_DRIVER) private readonly publicDriver: StorageDriver,
  ) {}

  async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Storage is "up" when the store the app writes to accepts writes:
   * STORAGE_ROOT in local mode (C30: an access check, not a
   * write-then-unlink of one shared probe file, which made overlapping
   * probes fail each other with 503), the bucket in S3 mode.
   */
  async checkStorage(): Promise<boolean> {
    return this.publicDriver.healthCheck();
  }
}
