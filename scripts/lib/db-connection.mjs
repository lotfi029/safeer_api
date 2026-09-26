// scripts/lib/db-connection.mjs — the connection the DDL-capable scripts
// (migrate.mjs, db-reset.mjs) open.
//
// C29: they use MIGRATION_DB_USER / MIGRATION_DB_PASSWORD, a separate
// DDL-capable account, so the running app can stay on the least-privilege
// account from scripts/create-app-db-user.sql. In development/test they fall
// back to DB_USER / DB_PASSWORD. In staging/production the migration account
// is required, so a deploy can't run DDL as the app user by accident.
//
// C9: UTC, same as the app (src/database/utc.ts): `timezone: 'Z'` for JS
// Dates, and `SET time_zone = '+00:00'` for NOW()/CURRENT_TIMESTAMP defaults.
// A3: the same statement takes MariaDB's SIMULTANEOUS_ASSIGNMENT out of
// sql_mode, so multi-assignment UPDATEs run left to right (see utc.ts).
// smoke.mjs and reprocess-media.mjs import it from here.

import mysql from 'mysql2/promise';
import { DEV_ENVS } from './node-env.mjs';

export const UTC_SESSION_SQL =
  "SET time_zone = '+00:00', " +
  "sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',SIMULTANEOUS_ASSIGNMENT,', ','))";

function required(scriptName, name, value) {
  if (value === undefined) {
    console.error(`${scriptName}: missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

export function migrationCredentials(scriptName, nodeEnv) {
  const user = process.env.MIGRATION_DB_USER;
  if (user) {
    return { user, password: required(scriptName, 'MIGRATION_DB_PASSWORD', process.env.MIGRATION_DB_PASSWORD) };
  }
  if (!DEV_ENVS.includes(nodeEnv)) {
    console.error(
      `${scriptName}: MIGRATION_DB_USER / MIGRATION_DB_PASSWORD are required when NODE_ENV=${nodeEnv}. ` +
        'Falling back to DB_USER only happens in development/test.',
    );
    process.exit(1);
  }
  return {
    user: required(scriptName, 'DB_USER', process.env.DB_USER),
    password: required(scriptName, 'DB_PASSWORD', process.env.DB_PASSWORD),
  };
}

/** Opens a UTC connection with the migration credentials. `database: null` connects without selecting one. */
export async function openMigrationConnection(scriptName, nodeEnv, { database, multipleStatements = true } = {}) {
  const { user, password } = migrationCredentials(scriptName, nodeEnv);
  const connection = await mysql.createConnection({
    host: required(scriptName, 'DB_HOST', process.env.DB_HOST),
    port: Number(process.env.DB_PORT ?? '3306'),
    user,
    password,
    database: database === null ? undefined : (database ?? required(scriptName, 'DB_NAME', process.env.DB_NAME)),
    // Full collation, not just the charset name (see database.module.ts) —
    // mysql2 otherwise negotiates utf8mb4_general_ci, not the
    // utf8mb4_unicode_ci every table in migrations/001_schema.sql uses.
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    multipleStatements,
  });
  await connection.query(UTC_SESSION_SQL);
  return connection;
}
