// scripts/lib/encryption-key-check.mjs — safeer-delivery-review.md A7.
//
// APP_ENCRYPTION_KEY encrypts the mail/SMS provider secrets and, since
// migration 012, every applications.id_number. A migrate (or app) run with a
// different key than the one the data was encrypted with would silently
// write rows nobody can read back — 012 did exactly that, then 013 dropped
// the plaintext.
//
// So the database remembers which key it belongs to:
// site_settings.encryption_key_check holds HMAC-SHA256(key, KEY_CHECK_LABEL)
// (018). It identifies the key without revealing it. migrate.mjs checks it
// before applying anything and stores it on first use; the app does the
// same at boot (src/database/encryption-key-check.ts — keep the two in step).
//
// On a database from before 018 (nothing stored yet), the key is checked by
// decrypting one value that is already encrypted, if there is one.

import { createDecipheriv, createHmac } from 'node:crypto';

export const KEY_CHECK_LABEL = 'safeer:app-encryption-key-check:v1';

/** The value stored in site_settings.encryption_key_check for `keyBase64`. */
export function keyCheckValue(keyBase64) {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(KEY_CHECK_LABEL).digest('hex');
}

/** True when `stored` (iv || authTag || ciphertext, as in src/mail/mail-crypto.ts) decrypts under `keyBase64`. */
function decrypts(stored, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(0, 12));
    decipher.setAuthTag(stored.subarray(12, 28));
    Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return rows.length > 0;
}

/** Values already encrypted under the database's key, one per place that holds them. */
const ENCRYPTED_PROBES = [
  ['mail_settings', 'password_encrypted'],
  ['sms_settings', 'token_encrypted'],
  ['applications', 'id_number_encrypted'],
];

const MISMATCH =
  'APP_ENCRYPTION_KEY does not match the key this database was encrypted with. Nothing was changed.\n' +
  'Use the original key (see docs/backend/DEPLOYMENT-HOSTINGER.md, "APP_ENCRYPTION_KEY").';

/**
 * Throws (with MISMATCH) when `keyBase64` is not this database's key.
 * Returns silently when there is nothing to compare against yet.
 */
export async function assertEncryptionKey(connection, keyBase64) {
  if (await columnExists(connection, 'site_settings', 'encryption_key_check')) {
    const [[row]] = await connection.query('SELECT encryption_key_check AS kcv FROM site_settings WHERE id = 1');
    if (row?.kcv) {
      if (row.kcv !== keyCheckValue(keyBase64)) throw new Error(MISMATCH);
      return;
    }
  }
  for (const [table, column] of ENCRYPTED_PROBES) {
    if (!(await columnExists(connection, table, column))) continue;
    const [[row]] = await connection.query(`SELECT \`${column}\` AS v FROM \`${table}\` WHERE \`${column}\` IS NOT NULL LIMIT 1`);
    if (row?.v) {
      if (!decrypts(Buffer.from(row.v), keyBase64)) throw new Error(MISMATCH);
      return;
    }
  }
}

/** Stores the check value once, on first use (the column exists from 018 on). */
export async function recordEncryptionKey(connection, keyBase64) {
  if (!(await columnExists(connection, 'site_settings', 'encryption_key_check'))) return;
  await connection.query('UPDATE site_settings SET encryption_key_check = ? WHERE id = 1 AND encryption_key_check IS NULL', [
    keyCheckValue(keyBase64),
  ]);
}
