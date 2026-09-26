import { createHmac } from 'node:crypto';
import { decryptSecret } from '../mail/mail-crypto.js';

/**
 * A7 (safeer-delivery-review.md): the app half of the APP_ENCRYPTION_KEY
 * guard; scripts/lib/encryption-key-check.mjs is the migrate half. Keep the
 * label and the probes in step with it.
 *
 * `site_settings.encryption_key_check` holds HMAC-SHA256(key, label). At boot
 * the app refuses to start when it doesn't match APP_ENCRYPTION_KEY; when
 * nothing is stored yet, it checks one value that is already encrypted (a
 * mail/SMS secret or an ID number), then stores the check value.
 */
export const KEY_CHECK_LABEL = 'safeer:app-encryption-key-check:v1';

export function keyCheckValue(keyBase64: string): string {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(KEY_CHECK_LABEL).digest('hex');
}

const ENCRYPTED_PROBES: Array<[table: string, column: string]> = [
  ['mail_settings', 'password_encrypted'],
  ['sms_settings', 'token_encrypted'],
  ['applications', 'id_number_encrypted'],
];

export const KEY_MISMATCH_MESSAGE =
  'APP_ENCRYPTION_KEY does not match the key this database was encrypted with — refusing to start. ' +
  'See docs/backend/DEPLOYMENT-HOSTINGER.md, "APP_ENCRYPTION_KEY".';

type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Throws KEY_MISMATCH_MESSAGE on a wrong key; otherwise stores the check value if it isn't yet. */
export async function assertAndRecordEncryptionKey(query: Query, keyBase64: string): Promise<void> {
  const expected = keyCheckValue(keyBase64);
  const [row] = await query('SELECT encryption_key_check AS kcv FROM site_settings WHERE id = 1');
  const stored = row?.kcv as string | null | undefined;
  if (stored) {
    if (stored !== expected) throw new Error(KEY_MISMATCH_MESSAGE);
    return;
  }

  for (const [table, column] of ENCRYPTED_PROBES) {
    const [probe] = await query(`SELECT \`${column}\` AS v FROM \`${table}\` WHERE \`${column}\` IS NOT NULL LIMIT 1`);
    if (!probe?.v) continue;
    try {
      decryptSecret(Buffer.from(probe.v as Buffer), keyBase64);
    } catch {
      throw new Error(KEY_MISMATCH_MESSAGE);
    }
    break;
  }

  await query('UPDATE site_settings SET encryption_key_check = ? WHERE id = 1 AND encryption_key_check IS NULL', [expected]);
}
