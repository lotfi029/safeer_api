-- 018_encryption_key_check.sql
-- safeer-delivery-review.md A7: 012 encrypted every ID number with whatever
-- APP_ENCRYPTION_KEY the migrate process had, and 013 then dropped the
-- plaintext. Nothing checked that it was the key the rest of the data (mail
-- and SMS secrets) was encrypted with.
--
-- encryption_key_check holds HMAC-SHA256(APP_ENCRYPTION_KEY, a fixed label):
-- it identifies the key without revealing it. migrate.mjs and the app store
-- it on first use and refuse to run with a key that doesn't match
-- (scripts/lib/encryption-key-check.mjs, src/database/encryption-key-check.ts).
ALTER TABLE site_settings
  ADD COLUMN encryption_key_check CHAR(64) NULL AFTER application_ref_prefix;
