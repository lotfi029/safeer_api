import { Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.tokens.js';
import { ConfigModule } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { entities } from './entities/index.js';
import { assertUtcSession, utcConnectionOptions } from './utc.js';
import { assertAndRecordEncryptionKey } from './encryption-key-check.js';

/**
 * `synchronize` is off in every environment (D-02, hard rule) — the schema
 * comes only from the hand-written SQL migrations in migrations/. The
 * connection's `charset` is the full collation name, not just `utf8mb4`:
 * mysql2 negotiates `utf8mb4_general_ci` for the bare charset name — not
 * the collation every table in 001_schema.sql actually uses. Getting the
 * charset itself wrong loads Arabic as `????` at write time (trap 1);
 * getting only the collation wrong is quieter — text reads back correctly,
 * but any query mixing a string literal with a table column (e.g. a UNION
 * with a literal `'documents' AS entity` column, P7's asset-usage query)
 * fails outright with "Illegal mix of collations", and accent-insensitive
 * comparisons silently stop being accent-insensitive at the connection
 * level even though every column is still correctly defined that way.
 *
 * The value is `utf8mb4_unicode_ci`, not MySQL 8's `utf8mb4_0900_ai_ci`, as
 * of 20 September 2026: the deployment target is Hostinger shared hosting,
 * which runs MariaDB, where `0900_ai_ci` does not exist at all. See
 * 38-hostinger-shared-deployment-review.md §1 and the header of
 * migrations/001_schema.sql for the full reasoning. Production has since
 * moved to MySQL 8.4 on the VPS (S4, docs/backend/DEPLOYMENT-VPS.md); the
 * collation stays, since it works on both engines and changing it would
 * mean rewriting every table.
 *
 * THIS STRING AND THE `COLLATE=` ON EVERY TABLE IN 001_schema.sql MUST
 * MATCH. Change one, change the other — the failure mode of getting it
 * wrong is that asset deletion breaks and nothing else does.
 *
 * Every connection is UTC (C9) — see utc.ts. Boot fails if it isn't, and
 * (A7) if APP_ENCRYPTION_KEY isn't the key this database's data was
 * encrypted with — see encryption-key-check.ts.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => ({
        type: 'mysql' as const,
        host: env.DB_HOST,
        port: env.DB_PORT,
        username: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
        charset: 'utf8mb4_unicode_ci',
        ...utcConnectionOptions,
        synchronize: false,
        entities,
        autoLoadEntities: true,
        retryAttempts: 3,
        retryDelay: 2000,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertUtcSession((sql) => this.dataSource.query(sql));
    // A7: refuse to start with an APP_ENCRYPTION_KEY that isn't this database's.
    await assertAndRecordEncryptionKey((sql, params) => this.dataSource.query(sql, params), this.env.APP_ENCRYPTION_KEY);
  }
}
