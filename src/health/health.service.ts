import { constants as fsConstants, promises as fs } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ENV) private readonly env: Env,
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
   * Storage is "up" when STORAGE_ROOT exists (or can be created) and is
   * writable. C30: an access check, not a write-then-unlink of one fixed
   * probe file — two overlapping probes raced on that file (one's unlink
   * removed the other's, which then failed with ENOENT and reported 503).
   */
  async checkStorage(): Promise<boolean> {
    try {
      await fs.mkdir(this.env.STORAGE_ROOT, { recursive: true });
      await fs.access(this.env.STORAGE_ROOT, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
