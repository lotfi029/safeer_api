// 012_encrypt_id_number.mjs
// safeer-backend-code-review.md C28: moves every plaintext
// applications.id_number into id_number_encrypted.
//
// The layout must stay byte-compatible with src/mail/mail-crypto.ts
// (encryptSecret/decryptSecret): AES-256-GCM under the raw
// APP_ENCRYPTION_KEY, stored as iv (12 bytes) || authTag (16) || ciphertext.
// The app reads the column back through src/database/encrypted-column.ts.

import { createCipheriv, randomBytes } from 'node:crypto';

function encrypt(plaintext, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export async function up(connection, { env, log }) {
  const [rows] = await connection.query(
    'SELECT id, id_number FROM applications WHERE id_number IS NOT NULL AND id_number_encrypted IS NULL',
  );
  if (rows.length === 0) {
    log('no plaintext ID numbers to encrypt');
    return;
  }
  const key = env.APP_ENCRYPTION_KEY;
  if (!key || Buffer.from(key, 'base64').length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY (32 bytes, base64) is required to encrypt existing applications.id_number values');
  }
  for (const row of rows) {
    await connection.query('UPDATE applications SET id_number_encrypted = ?, id_number = NULL WHERE id = ?', [
      encrypt(String(row.id_number), key),
      row.id,
    ]);
  }
  log(`encrypted ${rows.length} ID number(s)`);
}
