import mysql2 from 'mysql2';

/**
 * C9: every connection runs in UTC, whatever the process's own `TZ` or the
 * server's `@@global.time_zone`.
 *
 * The code mixes two clocks: JS `new Date(...)` values written through
 * mysql2 (session/OTP/token `expires_at`) and SQL `NOW()` /
 * `CURRENT_TIMESTAMP(3)` comparisons and defaults (session.guard.ts,
 * auth.service.ts). They only agree when both sides are UTC:
 *
 * - `timezone: 'Z'` makes mysql2 serialise a JS Date as UTC and parse a
 *   DATETIME back as UTC (its default, 'local', uses the process TZ — so an
 *   app started with `TZ=Asia/Riyadh` wrote every expiry 3 hours late).
 * - `SET time_zone = '+00:00'` makes `NOW()`/`CURRENT_TIMESTAMP` UTC on the
 *   server side, for every pooled connection — including the probe
 *   connection TypeORM opens during `initialize()`, which is why this hooks
 *   `createPool` itself rather than the pool TypeORM hands back.
 * - `dateStrings: ['DATE']` keeps date-only columns (`birth_date`,
 *   `published_on`, `doc_date`) as plain `YYYY-MM-DD` strings; with
 *   `timezone: 'Z'` mysql2 would otherwise build a UTC-midnight Date that
 *   TypeORM formats back with *local* getters — the previous day west of UTC.
 *
 * A3: the same statement also takes MariaDB's `SIMULTANEOUS_ASSIGNMENT` out
 * of `sql_mode`. Several atomic UPDATEs (AuthService.registerFailedAttempt,
 * PortalOtpService's failure counter) rely on SET being evaluated left to
 * right, each assignment seeing the previous ones — MySQL's only behaviour,
 * and MariaDB's default, but that mode makes MariaDB evaluate every
 * right-hand side against the old row, which would silently break the
 * lockout counters. On MySQL the mode doesn't exist and this is a no-op.
 */
export const UTC_SESSION_SQL =
  "SET time_zone = '+00:00', " +
  "sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',SIMULTANEOUS_ASSIGNMENT,', ','))";

type Mysql2 = typeof mysql2;

const utcMysqlDriver: Mysql2 = {
  ...mysql2,
  createPool(config: Parameters<Mysql2['createPool']>[0]) {
    const pool = mysql2.createPool(config as never);
    pool.on('connection', (connection) => {
      connection.query(UTC_SESSION_SQL, (err) => {
        // Fail closed: a connection that could not be switched to UTC would
        // silently compare expiries against the wrong clock.
        if (err) connection.destroy();
      });
    });
    return pool;
  },
} as Mysql2;

export const utcConnectionOptions = {
  timezone: 'Z',
  dateStrings: ['DATE'],
  driver: utcMysqlDriver,
};

/** Throws unless the connection's `NOW()` is UTC and SET runs left to right (A3). Run once at boot. */
export async function assertUtcSession(query: (sql: string) => Promise<Array<Record<string, unknown>>>): Promise<void> {
  const [row] = await query(
    "SELECT @@session.time_zone AS tz, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS drift, FIND_IN_SET('SIMULTANEOUS_ASSIGNMENT', @@session.sql_mode) AS simultaneous",
  );
  if (Number(row?.drift) !== 0) {
    throw new Error(`Database session is not UTC (time_zone=${String(row?.tz)}, drift=${String(row?.drift)}s) — see src/database/utc.ts`);
  }
  if (Number(row?.simultaneous) !== 0) {
    throw new Error('Database session has SIMULTANEOUS_ASSIGNMENT in sql_mode — see src/database/utc.ts');
  }
}
