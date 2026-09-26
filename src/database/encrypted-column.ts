import type { ValueTransformer } from 'typeorm';
import { loadEnv } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../mail/mail-crypto.js';

/**
 * C28: a string column stored encrypted (AES-256-GCM under
 * APP_ENCRYPTION_KEY — mail-crypto.ts's layout, also written by
 * migrations/012_encrypt_id_number.mjs). The entity property stays a plain
 * string; every read decrypts and every write encrypts, so no service code
 * handles ciphertext.
 */
export const encryptedString: ValueTransformer = {
  to(value: string | null | undefined): Buffer | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return encryptSecret(value, loadEnv().APP_ENCRYPTION_KEY);
  },
  from(value: Buffer | null): string | null {
    if (!value) return null;
    return decryptSecret(Buffer.from(value), loadEnv().APP_ENCRYPTION_KEY);
  },
};
