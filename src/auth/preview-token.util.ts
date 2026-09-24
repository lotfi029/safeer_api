import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * FR-G-05 (7.8): lets an editor preview an unpublished row through the same
 * public detail route a visitor will eventually see, without a second
 * "draft" endpoint to keep in sync. Same shape as `csrf.util.ts`'s
 * double-submit token — an HMAC over the thing being authorised, keyed by a
 * dedicated HKDF-derived key so this can never leak anything about
 * `APP_ENCRYPTION_KEY` itself (P10's AES-256-GCM key for the stored SMTP
 * password) — but this one is *bearer*, not session-bound: it has to work
 * when pasted into a link and opened in a browser with no session cookie at
 * all (an editor sharing a preview link with someone outside the CMS is the
 * entire point of FR-G-05).
 *
 * Deliberately not a session token, a JWT, or anything stored in a table:
 * short-lived, single-purpose, stateless to verify, and scoped to exactly
 * one (collection, id) pair — a token minted for `posts/9` decodes and
 * verifies fine but is simply never checked against, and so never unlocks,
 * `library_items/9`.
 */
const PREVIEW_TOKEN_INFO = 'safeer-preview-v1';

/**
 * Table names — also the CRUD kernel's `entityType`/audit `entity_type` for
 * whichever collections opt into preview (crud.factory.ts).
 *
 * TODO(phase 4+): add the previewable collections as their modules land
 * (e.g. 'news' for the posts-equivalent content, once the News module and
 * entity exist) — see preview.controller.ts's PREVIEW_COLLECTIONS.
 */
export type PreviewCollection = never;

export const PREVIEW_TOKEN_TTL_SECONDS = 15 * 60;

function derivePreviewKey(appEncryptionKeyBase64: string): Buffer {
  const master = Buffer.from(appEncryptionKeyBase64, 'base64');
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), PREVIEW_TOKEN_INFO, 32));
}

function sign(key: Buffer, collection: PreviewCollection, id: string, expiresAtMs: number): string {
  return createHmac('sha256', key).update(`${collection}|${id}|${expiresAtMs}`).digest('base64url');
}

/** `<expiresAtMs>.<signature>` — the expiry travels with the token so verification never needs a lookup. */
export function issuePreviewToken(appEncryptionKeyBase64: string, collection: PreviewCollection, id: string): string {
  const key = derivePreviewKey(appEncryptionKeyBase64);
  const expiresAtMs = Date.now() + PREVIEW_TOKEN_TTL_SECONDS * 1000;
  return `${expiresAtMs}.${sign(key, collection, id, expiresAtMs)}`;
}

/** Verifies `token` authorises exactly this (collection, id) pair, and has not expired. */
export function verifyPreviewToken(appEncryptionKeyBase64: string, collection: PreviewCollection, id: string, token: string): boolean {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex < 1) return false;
  const expiresAtRaw = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return false;

  const key = derivePreviewKey(appEncryptionKeyBase64);
  const expected = sign(key, collection, id, expiresAtMs);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}
