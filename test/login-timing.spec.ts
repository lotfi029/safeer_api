// test/login-timing.spec.ts — A2 (safeer-delivery-review.md): staff login
// must not reveal which emails exist. An unknown email used to answer in
// ~5 ms and an active account in ~145 ms, because the refusal paths
// verified against the m=1,t=1 placeholder hash. Every path now runs a real
// Argon2 verify at the same cost (PasswordService.verifyDummy).
//
// The timing check is deliberately loose (medians, a 0.4 ratio, not
// milliseconds) and is the only test in this file, so the retry below
// covers it alone: a noisy CI runner gets two more tries, a real leak
// (ratio ≈ 0.03) fails all three.

import { api, createTempUser, deleteTempUser, withDb } from './helpers';
import { ARGON2_OPTIONS, argon2Params } from '../src/auth/argon2-options';

jest.retryTimes(2, { logErrorsBeforeRetry: true });

const SAMPLES = 4;

async function timedLogin(email: string, password: string): Promise<number> {
  const started = process.hrtime.bigint();
  const res = await api('POST', '/admin/auth/login', { body: { email, password } });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  expect(res.status).toBe(401);
  return elapsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe('A2: equal-cost staff login', () => {
  it('unknown, disabled, brute-force-locked and active accounts take about as long to refuse', async () => {
    // The app hashed the bootstrap admin's password itself (PasswordService),
    // with the same parameters the dummy hash is built with.
    const [admin]: any = await withDb((conn) =>
      conn.execute("SELECT password_hash FROM users WHERE email = ?", [process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@safeer-sa.org']).then(([rows]: any) => rows),
    );
    expect(argon2Params(admin.password_hash)).toEqual({ m: ARGON2_OPTIONS.memoryCost, t: ARGON2_OPTIONS.timeCost, p: ARGON2_OPTIONS.parallelism });

    const active = await createTempUser('editor');
    const disabled = await createTempUser('editor');
    const locked = await createTempUser('editor');
    try {
      await withDb(async (conn) => {
        await conn.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.id]);
        await conn.execute('UPDATE users SET locked_until = UTC_TIMESTAMP(3) + INTERVAL 1 HOUR WHERE id = ?', [locked.id]);
      });

      // Warm-up: the first Argon2 call in a process allocates its memory.
      await api('POST', '/admin/auth/login', { body: { email: `jest-warmup-${Date.now()}@example.com`, password: 'x' } });

      const times = { unknown: [] as number[], disabled: [] as number[], locked: [] as number[], active: [] as number[] };
      // Interleaved, so drift in the runner's speed hits every path alike.
      // At most SAMPLES (< 5) tries per email: the per-email limiter allows 5 a minute.
      for (let i = 0; i < SAMPLES; i++) {
        times.unknown.push(await timedLogin(`jest-nobody-${Date.now()}-${i}@example.com`, 'Wrong-P4ssword!'));
        times.disabled.push(await timedLogin(disabled.email, 'Wrong-P4ssword!'));
        times.locked.push(await timedLogin(locked.email, 'Wrong-P4ssword!'));
        times.active.push(await timedLogin(active.email, 'Wrong-P4ssword!'));
      }

      // Before A2 each ratio was about 0.03. Failing entries print as [path, ratio].
      const activeMedian = median(times.active);
      const ratios = (['unknown', 'disabled', 'locked'] as const).map((path) => [path, Number((median(times[path]) / activeMedian).toFixed(2))] as const);
      expect(ratios.filter(([, ratio]) => ratio < 0.4)).toEqual([]);
    } finally {
      await deleteTempUser(active.id);
      await deleteTempUser(disabled.id);
      await deleteTempUser(locked.id);
    }
  });
});
