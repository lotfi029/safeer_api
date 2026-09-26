import * as argon2 from 'argon2';

/**
 * FR-A-01: Argon2id, with its cost written out rather than left to the
 * library's defaults (these equal argon2 0.45's defaults, so every hash
 * stored before this was made explicit costs the same to verify).
 *
 * A2: PasswordService builds its dummy hash with exactly these options, so
 * a sign-in for an unknown, disabled or locked account runs the same
 * Argon2 work as one for an active account.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

/** The cost parameters of an encoded hash, e.g. `{ m: 65536, t: 3, p: 4 }` (their order in the string varies). */
export function argon2Params(encoded: string): { m: number; t: number; p: number } | null {
  const segment = encoded.split('$')[3];
  if (!segment) return null;
  const params = Object.fromEntries(segment.split(',').map((kv) => kv.split('=') as [string, string]));
  const [m, t, p] = [Number(params.m), Number(params.t), Number(params.p)];
  return Number.isFinite(m) && Number.isFinite(t) && Number.isFinite(p) ? { m, t, p } : null;
}
