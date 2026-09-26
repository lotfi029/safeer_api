import type { CookieOptions } from 'express';
import { isDevEnv, type Env } from '../config/env.js';

/**
 * Staff and applicant session cookies share one attribute set. C32:
 * `Secure` everywhere except development/test (was production only, so a
 * staging deployment sent session cookies over plain HTTP). Staging must
 * therefore be served over HTTPS, like production.
 */
export function sessionCookieOptions(env: Pick<Env, 'NODE_ENV'>, maxAgeMs: number): CookieOptions {
  return { ...baseOptions(env), maxAge: maxAgeMs };
}

/** clearCookie() with the same attributes the cookie was set with. */
export function clearSessionCookieOptions(env: Pick<Env, 'NODE_ENV'>): CookieOptions {
  return baseOptions(env);
}

function baseOptions(env: Pick<Env, 'NODE_ENV'>): CookieOptions {
  return { httpOnly: true, secure: !isDevEnv(env), sameSite: 'strict', path: '/' };
}
