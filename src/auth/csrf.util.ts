import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Double-submit CSRF token, derived (not stored) so no new column or table
 * is needed on `sessions` (12-database.md never anticipated one).
 *
 * The token is `HMAC-SHA256(csrfKey, sessionTokenHash)`, deterministic per
 * session — recomputing it needs the session's own token_hash, which an
 * attacker forging a cross-site request cannot read (the cookie is
 * httpOnly). `csrfKey` is derived from APP_ENCRYPTION_KEY via HKDF with a
 * distinct info string, not the raw key itself — key separation, so this
 * use can never leak anything about the AES-256-GCM key that encrypts the
 * stored SMTP password (P10).
 */
function deriveCsrfKey(appEncryptionKeyBase64: string): Buffer {
  const master = Buffer.from(appEncryptionKeyBase64, 'base64');
  const derived = hkdfSync('sha256', master, Buffer.alloc(0), 'safeer-csrf-v1', 32);
  return Buffer.from(derived);
}

export function computeCsrfToken(appEncryptionKeyBase64: string, sessionTokenHash: string): string {
  const key = deriveCsrfKey(appEncryptionKeyBase64);
  return createHmac('sha256', key).update(sessionTokenHash).digest('hex');
}
