-- 013_drop_plain_id_number.sql
-- safeer-backend-code-review.md C28: 012 has moved every value into
-- id_number_encrypted; the plaintext column goes.
ALTER TABLE applications DROP COLUMN id_number;
