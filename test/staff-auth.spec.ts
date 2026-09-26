// test/staff-auth.spec.ts — Phase 3 of the fix plan, staff accounts:
//   C3  users.status (active | disabled | invited), separate from the brute-force lock;
//       disabled users get nothing from forgot/reset/accept; tokens die on disable,
//       email change and use
//   C4  login writes only targeted, atomic UPDATEs (no lost increments, can't undo a reset)
//   C12 a time-boxed lock with backoff that doesn't end sessions; admin unlock clears it

import { createHash, randomBytes } from 'node:crypto';
import { adminApi, api, createTempUser, deleteTempUser, settleForgot, withDb } from './helpers';
import { UTC_SESSION_SQL } from '../src/database/utc';

const PASSWORD = 'Jest-Test-P4ssword!';

async function userRow(id: string): Promise<any> {
  return withDb((conn) =>
    conn
      .execute(
        'SELECT status, failed_logins, lock_count, locked_until, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), locked_until) AS lock_left, ' +
          'TIMESTAMPDIFF(SECOND, last_failed_login_at, UTC_TIMESTAMP(3)) AS since_last_failure, password_hash FROM users WHERE id = ?',
        [id],
      )
      .then(([rows]: any) => rows[0]),
  );
}

async function insertToken(userId: string, purpose: 'invite' | 'reset'): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await withDb((conn) =>
    conn.execute('INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 HOUR)', [
      userId,
      purpose,
      createHash('sha256').update(raw).digest('hex'),
    ]),
  );
  return raw;
}

async function liveTokens(userId: string): Promise<number> {
  return withDb((conn) =>
    conn.execute('SELECT COUNT(*) AS c FROM auth_tokens WHERE user_id = ? AND used_at IS NULL', [userId]).then(([rows]: any) => Number(rows[0].c)),
  );
}

async function login(email: string, password: string) {
  return api('POST', '/admin/auth/login', { body: { email, password } });
}

describe('staff auth', () => {
  describe('C3: account status', () => {
    it('disabling ends sessions, deletes outstanding tokens, and a reset link cannot re-enable the account', async () => {
      const user = await createTempUser('editor');
      try {
        const token = await insertToken(user.id, 'reset');
        const disabled = await adminApi('PATCH', `/admin/users/${user.id}`, { body: { status: 'disabled' } });
        expect(disabled.status).toBe(200);
        expect(disabled.body.status).toBe('disabled');

        expect((await api('GET', '/admin/me', { session: user })).status).toBe(401);
        expect(await liveTokens(user.id)).toBe(0);

        // Even a token minted after the disable is refused, and forgot-password sends nothing.
        const late = await insertToken(user.id, 'reset');
        expect((await api('POST', `/admin/auth/reset/${late}`, { body: { password: 'Another-P4ssword!' } })).status).toBe(400);
        expect((await api('POST', `/admin/auth/reset/${token}`, { body: { password: 'Another-P4ssword!' } })).status).toBe(400);
        await withDb((conn) => conn.execute('DELETE FROM auth_tokens WHERE user_id = ?', [user.id]));
        await api('POST', '/admin/auth/forgot', { body: { email: user.email } });
        await settleForgot();
        expect(await liveTokens(user.id)).toBe(0);
        expect((await userRow(user.id)).status).toBe('disabled');
        expect((await login(user.email, PASSWORD)).status).toBe(401);

        const reenabled = await adminApi('PATCH', `/admin/users/${user.id}`, { body: { status: 'active' } });
        expect(reenabled.status).toBe(200);
        expect((await login(user.email, PASSWORD)).status).toBe(201);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('an email change deletes outstanding tokens; using one token deletes the others', async () => {
      const user = await createTempUser('editor');
      try {
        await insertToken(user.id, 'reset');
        await adminApi('PATCH', `/admin/users/${user.id}`, { body: { email: `changed-${Date.now()}@example.com` } });
        expect(await liveTokens(user.id)).toBe(0);

        const first = await insertToken(user.id, 'reset');
        const second = await insertToken(user.id, 'reset');
        expect((await api('POST', `/admin/auth/reset/${first}`, { body: { password: 'Brand-New-P4ss!' } })).status).toBe(201);
        expect(await liveTokens(user.id)).toBe(0);
        expect((await api('POST', `/admin/auth/reset/${second}`, { body: { password: 'Another-New-P4ss!' } })).status).toBe(400);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('invited users start as invited, get no reset link, and become active on accept', async () => {
      const email = `jest-invited-${Date.now()}@example.com`;
      const invited = await adminApi('POST', '/admin/auth/invite', { body: { email, name: 'Invited Person', role: 'editor' } });
      expect(invited.status).toBe(201);
      expect(invited.body.status).toBe('invited');
      try {
        await withDb((conn) => conn.execute("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'invite'", [invited.body.id]));
        await api('POST', '/admin/auth/forgot', { body: { email } });
        await settleForgot();
        expect(await liveTokens(invited.body.id)).toBe(0);

        const token = await insertToken(invited.body.id, 'invite');
        const accepted = await api('POST', `/admin/auth/accept/${token}`, { body: { password: 'Accepted-P4ssword!' } });
        expect(accepted.status).toBe(201);
        expect((await userRow(invited.body.id)).status).toBe('active');
        expect((await login(email, 'Accepted-P4ssword!')).status).toBe(201);
      } finally {
        await withDb((conn) => conn.execute('DELETE FROM users WHERE email = ?', [email]));
      }
    });
  });

  describe('C4: atomic login writes', () => {
    it('parallel wrong passwords all count', async () => {
      const user = await createTempUser('editor');
      try {
        await Promise.all(Array.from({ length: 5 }, () => login(user.email, 'wrong-password')));
        expect(Number((await userRow(user.id)).failed_logins)).toBe(5);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('a login in flight cannot undo a password reset', async () => {
      const user = await createTempUser('editor');
      try {
        for (let round = 0; round < 3; round++) {
          const token = await insertToken(user.id, 'reset');
          const newPassword = `Reset-Round-${round}-P4ss!`;
          const oldPassword = round === 0 ? PASSWORD : `Reset-Round-${round - 1}-P4ss!`;
          await Promise.all([login(user.email, oldPassword), api('POST', `/admin/auth/reset/${token}`, { body: { password: newPassword } })]);
          expect((await login(user.email, newPassword)).status).toBe(201);
          expect((await login(user.email, oldPassword)).status).toBe(401);
        }
      } finally {
        await deleteTempUser(user.id);
      }
    });
  });

  describe('C12: time-boxed lockout', () => {
    it('locks for 15 min at 10 failures without ending sessions, then backs off; admin unlock clears it', async () => {
      const user = await createTempUser('editor');
      try {
        await withDb((conn) => conn.execute('UPDATE users SET failed_logins = 9 WHERE id = ?', [user.id]));
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        let row = await userRow(user.id);
        expect(Math.abs(Number(row.lock_left) - 15 * 60)).toBeLessThanOrEqual(15);
        expect(Number(row.lock_count)).toBe(1);

        // Existing sessions survive a brute-force lock; a correct password is refused while it runs.
        expect((await api('GET', '/admin/me', { session: user })).status).toBe(200);
        expect((await login(user.email, PASSWORD)).status).toBe(401);

        // Expired lock: sign-in works again; a second lock doubles (lock_count kept until a good sign-in).
        await withDb((conn) => conn.execute('UPDATE users SET locked_until = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND, failed_logins = 9 WHERE id = ?', [user.id]));
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        row = await userRow(user.id);
        expect(Math.abs(Number(row.lock_left) - 30 * 60)).toBeLessThanOrEqual(15);

        const unlocked = await adminApi('PATCH', `/admin/users/${user.id}`, { body: { unlock: true } });
        expect(unlocked.status).toBe(200);
        expect(unlocked.body.isLocked).toBe(false);
        row = await userRow(user.id);
        expect(row.locked_until).toBeNull();
        expect(Number(row.failed_logins)).toBe(0);

        expect((await login(user.email, PASSWORD)).status).toBe(201);
        expect(Number((await userRow(user.id)).lock_count)).toBe(0);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    // A3 (safeer-delivery-review.md): lock_count never decayed, so someone
    // who knew an admin's email could push every lock up to 16 h.
    it('A3: no single lock lasts more than 1 h, however many locks came before', async () => {
      const user = await createTempUser('editor');
      try {
        await withDb((conn) => conn.execute('UPDATE users SET lock_count = 6, failed_logins = 9, last_failed_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id]));
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        const row = await userRow(user.id);
        expect(Number(row.lock_left)).toBeLessThanOrEqual(3600);
        expect(Math.abs(Number(row.lock_left) - 3600)).toBeLessThanOrEqual(15);
        expect(Number(row.lock_count)).toBe(7);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('A3: locks go 15 → 30 → 60 → 60 min', async () => {
      const user = await createTempUser('editor');
      try {
        for (const minutes of [15, 30, 60, 60]) {
          await withDb((conn) =>
            conn.execute(
              'UPDATE users SET locked_until = IF(locked_until IS NULL, NULL, UTC_TIMESTAMP(3) - INTERVAL 1 SECOND), failed_logins = 9, last_failed_login_at = UTC_TIMESTAMP(3) WHERE id = ?',
              [user.id],
            ),
          );
          expect((await login(user.email, 'wrong-password')).status).toBe(401);
          expect(Math.abs(Number((await userRow(user.id)).lock_left) - minutes * 60)).toBeLessThanOrEqual(15);
        }
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('A3: the backoff resets 24 h after the last lock ended', async () => {
      const user = await createTempUser('editor');
      try {
        await withDb((conn) =>
          conn.execute(
            'UPDATE users SET lock_count = 3, locked_until = UTC_TIMESTAMP(3) - INTERVAL 25 HOUR, failed_logins = 9, last_failed_login_at = UTC_TIMESTAMP(3) WHERE id = ?',
            [user.id],
          ),
        );
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        const row = await userRow(user.id);
        expect(Math.abs(Number(row.lock_left) - 15 * 60)).toBeLessThanOrEqual(15);
        expect(Number(row.lock_count)).toBe(1);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('A3: failed_logins resets after 24 h without a wrong password', async () => {
      const user = await createTempUser('editor');
      try {
        await withDb((conn) =>
          conn.execute('UPDATE users SET failed_logins = 9, last_failed_login_at = UTC_TIMESTAMP(3) - INTERVAL 25 HOUR WHERE id = ?', [user.id]),
        );
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        const row = await userRow(user.id);
        expect(Number(row.failed_logins)).toBe(1);
        expect(row.locked_until).toBeNull();
        expect(Math.abs(Number(row.since_last_failure))).toBeLessThanOrEqual(15);

        // Within 24 h the count keeps growing as before.
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        expect(Number((await userRow(user.id)).failed_logins)).toBe(2);
      } finally {
        await deleteTempUser(user.id);
      }
    });

    it('A3: a failure 1 h ago still counts — 9 of them plus one more locks', async () => {
      const user = await createTempUser('editor');
      try {
        await withDb((conn) =>
          conn.execute('UPDATE users SET failed_logins = 9, last_failed_login_at = UTC_TIMESTAMP(3) - INTERVAL 1 HOUR WHERE id = ?', [user.id]),
        );
        expect((await login(user.email, 'wrong-password')).status).toBe(401);
        const row = await userRow(user.id);
        expect(Math.abs(Number(row.lock_left) - 15 * 60)).toBeLessThanOrEqual(15);
        expect(Number(row.failed_logins)).toBe(0);
      } finally {
        await deleteTempUser(user.id);
      }
    });
  });

  // A3: the counters above rely on SET running left to right. MariaDB's
  // SIMULTANEOUS_ASSIGNMENT mode would evaluate every right-hand side against
  // the old row; src/database/utc.ts takes it out on every connection.
  describe('A3: SET runs left to right on every connection', () => {
    it('UTC_SESSION_SQL removes SIMULTANEOUS_ASSIGNMENT (MariaDB) and is a no-op elsewhere', async () => {
      await withDb(async (conn) => {
        const [[{ version }]]: any = await conn.query('SELECT VERSION() AS version');
        const mariadb = /mariadb/i.test(version);
        if (mariadb) {
          await conn.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',SIMULTANEOUS_ASSIGNMENT')");
          const [[on]]: any = await conn.query("SELECT FIND_IN_SET('SIMULTANEOUS_ASSIGNMENT', @@SESSION.sql_mode) AS pos");
          expect(Number(on.pos)).toBeGreaterThan(0);
        }
        const [[before]]: any = await conn.query('SELECT @@SESSION.sql_mode AS mode');
        await conn.query(UTC_SESSION_SQL);
        const [[after]]: any = await conn.query("SELECT @@SESSION.sql_mode AS mode, FIND_IN_SET('SIMULTANEOUS_ASSIGNMENT', @@SESSION.sql_mode) AS pos");
        expect(Number(after.pos)).toBe(0);
        if (!mariadb) expect(after.mode).toBe(before.mode);

        await conn.query('CREATE TEMPORARY TABLE a3_set_order (a INT, b INT)');
        await conn.query('INSERT INTO a3_set_order VALUES (1, 0)');
        await conn.query('UPDATE a3_set_order SET a = a + 1, b = a');
        const [[row]]: any = await conn.query('SELECT a, b FROM a3_set_order');
        expect({ a: row.a, b: row.b }).toEqual({ a: 2, b: 2 });
      });
    });
  });

  it('B7: a disabled account is not a valid assignee', async () => {
    const reviewer = await createTempUser('reviewer');
    try {
      await adminApi('PATCH', `/admin/users/${reviewer.id}`, { body: { status: 'disabled' } });
      const assignees = await adminApi('GET', '/admin/applications/assignees');
      expect(assignees.body.some((u: any) => u.id === reviewer.id)).toBe(false);
    } finally {
      await deleteTempUser(reviewer.id);
    }
  });
});

