import { createHash, randomBytes } from 'node:crypto';

/** The cookie value: 32 random bytes. Only its SHA-256 ever reaches the database (D-06). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
