import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12; // AES-GCM standard nonce size
const AUTH_TAG_LENGTH = 16;

/**
 * AES-256-GCM under the raw `APP_ENCRYPTION_KEY` (13-backend-build-plan.md
 * P10 step 1, trap 10) — unlike the CSRF token (auth/csrf.util.ts), this
 * uses the master key directly rather than an HKDF sub-key, per the plan's
 * literal wording ("encrypt … under APP_ENCRYPTION_KEY"). Stored layout is
 * `iv || authTag || ciphertext`, all in one VARBINARY column.
 */
export function encryptSecret(plaintext: string, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptSecret(stored: Buffer, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = stored.subarray(0, IV_LENGTH);
  const authTag = stored.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = stored.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
