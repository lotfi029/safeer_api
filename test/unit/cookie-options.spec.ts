// C32: session cookies are Secure everywhere except development/test.
import { clearSessionCookieOptions, sessionCookieOptions } from '../../src/auth/cookie-options';

describe('session cookie options (C32)', () => {
  it.each(['staging', 'production'] as const)('%s: Secure, HttpOnly, SameSite=Strict', (NODE_ENV) => {
    expect(sessionCookieOptions({ NODE_ENV }, 1000)).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 1000 });
    expect(clearSessionCookieOptions({ NODE_ENV }).secure).toBe(true);
  });

  it.each(['development', 'test'] as const)('%s: not Secure (plain-HTTP localhost)', (NODE_ENV) => {
    expect(sessionCookieOptions({ NODE_ENV }, 1000).secure).toBe(false);
  });
});
