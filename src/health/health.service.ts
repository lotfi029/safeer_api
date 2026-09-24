import { promises as fs } from 'node:fs';
import path from 'node:path';
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

  /** Storage is "up" when STORAGE_ROOT exists (or can be created) and is writable. */
  async checkStorage(): Promise<boolean> {
    try {
      await fs.mkdir(this.env.STORAGE_ROOT, { recursive: true });
      const probe = path.join(this.env.STORAGE_ROOT, '.health-check');
      await fs.writeFile(probe, '');
      await fs.unlink(probe);
      return true;
    } catch {
      return false;
    }
  }
}
