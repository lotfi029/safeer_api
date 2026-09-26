import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * C27: signed newsletter links — no token table, the signature is the proof.
 * The key is derived from APP_ENCRYPTION_KEY with its own HKDF info string,
 * so it never doubles as the CSRF or preview key.
 *
 *   confirm      `<expiresAtMs>.<sig>` — double opt-in, valid CONFIRM_TTL_MS
 *   unsubscribe  `<sig>`               — no expiry: it is printed in mail
 *                                        that may be opened months later
 */
export type NewsletterAction = 'confirm' | 'unsubscribe';

const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function key(appEncryptionKeyBase64: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appEncryptionKeyBase64, 'base64'), Buffer.alloc(0), 'safeer-newsletter-v1', 32));
}

function sign(appKey: string, action: NewsletterAction, email: string, expiresAtMs: number | null): string {
  return createHmac('sha256', key(appKey))
    .update(`${action}|${email.trim().toLowerCase()}|${expiresAtMs ?? ''}`)
    .digest('base64url');
}

export function issueNewsletterToken(appKey: string, action: NewsletterAction, email: string, now = Date.now()): string {
  if (action === 'unsubscribe') return sign(appKey, action, email, null);
  const expiresAtMs = now + CONFIRM_TTL_MS;
  return `${expiresAtMs}.${sign(appKey, action, email, expiresAtMs)}`;
}

export function verifyNewsletterToken(appKey: string, action: NewsletterAction, email: string, token: string, now = Date.now()): boolean {
  let expiresAtMs: number | null = null;
  let sig = token;
  if (action === 'confirm') {
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    expiresAtMs = Number(token.slice(0, dot));
    sig = token.slice(dot + 1);
    if (!Number.isFinite(expiresAtMs) || now > expiresAtMs) return false;
  }
  const expected = Buffer.from(sign(appKey, action, email, expiresAtMs));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
