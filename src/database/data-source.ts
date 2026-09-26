import 'reflect-metadata';
// The CLI (unlike the Nest app, which loads it via @nestjs/config) does not
// read .env on its own.
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env.js';
import { entities } from './entities/index.js';
import { utcConnectionOptions } from './utc.js';

/**
 * Plain TypeORM DataSource for the CLI only — `schema:check` (P4) is the one
 * thing the CLI is used for. Migrations are hand-written SQL run by
 * scripts/migrate.mjs (decision D-02); this DataSource never runs
 * `synchronize` and TypeORM's own migration generator is not used.
 */
const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  // Full collation, not just the charset name — see database.module.ts.
  charset: 'utf8mb4_unicode_ci',
  // UTC on every connection (C9) — see utc.ts.
  ...utcConnectionOptions,
  synchronize: false,
  entities,
});
