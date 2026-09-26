-- 019_upgrade_path_fixes.sql
-- safeer-delivery-review.md A11: two gaps a database upgraded from before
-- 007/008 can still carry. (007 and 008 are applied, so they can't change.)

-- 1. C1 (007) stopped OTP codes reaching sms_log / mail_log, but rows
--    written before it still hold them: the code in the SMS text, and in the
--    OTP mail's subject and stored payload. Mask every 6-digit run in OTP
--    rows the same way new rows are masked, and drop the old payloads (an
--    OTP mail can't be retried usefully anyway — the code has expired).
UPDATE sms_log
SET message = REGEXP_REPLACE(message, '[0-9]{6}', '••••••')
WHERE template_key = 'otp_code' AND message REGEXP '[0-9]{6}';

UPDATE sms_log SET payload = NULL WHERE template_key = 'otp_code' AND payload IS NOT NULL;

UPDATE mail_log
SET subject = REGEXP_REPLACE(subject, '[0-9]{6}', '••••••')
WHERE template_key = 'otp_code' AND subject REGEXP '[0-9]{6}';

UPDATE mail_log SET payload = NULL WHERE template_key = 'otp_code' AND payload IS NOT NULL;

-- 2. 008 turned every `is_locked` account into `disabled`, because the old
--    flag couldn't tell an admin's decision from a brute-force lock. If that
--    caught every admin, nobody can sign in to re-enable anyone. When no
--    active admin is left, re-enable one disabled admin — the one who signed
--    in most recently — with its lock and counters cleared.
--    (Derived tables, because MySQL can't read the table an UPDATE targets.)
UPDATE users u
JOIN (
  SELECT id FROM users
  WHERE role = 'admin' AND status = 'disabled'
  ORDER BY last_login_at IS NULL, last_login_at DESC, id
  LIMIT 1
) pick ON pick.id = u.id
SET u.status = 'active', u.locked_until = NULL, u.failed_logins = 0, u.lock_count = 0
WHERE (SELECT n FROM (SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active') active_admins) = 0;
