-- 011_id_number_encrypted.sql
-- safeer-backend-code-review.md C28: national ID numbers are stored
-- encrypted (AES-256-GCM under APP_ENCRYPTION_KEY, the same layout as
-- mail_settings.password_encrypted: iv || authTag || ciphertext).
-- 012 encrypts the existing rows; 013 drops the plaintext column.
ALTER TABLE applications ADD COLUMN id_number_encrypted VARBINARY(255) NULL AFTER id_number;
