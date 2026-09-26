-- 007_otp_privacy_and_limits.sql
-- safeer-backend-code-review.md C1, C16, C22.

-- C1: the one-time code never appears in a mail subject — mail_log.subject
-- is stored for 90 days and listed at GET /admin/mail/log. The body still
-- carries it (masked in mail_log, see MailService); only the subject changes.
UPDATE mail_templates
SET subject_ar = 'رمز الدخول إلى بوابة الطالب',
    subject_en = 'Your student portal sign-in code'
WHERE `key` = 'otp_code';

-- C16: contact_ack goes to an unverified address typed into the contact
-- form, so it must not echo anything that address's owner didn't write —
-- including the submitted name (a phishing link typed as a "name" would
-- otherwise arrive inside a genuine Safeer email).
UPDATE mail_templates
SET body_ar = REPLACE(body_ar, 'مرحبًا {{name}}،', 'مرحبًا،'),
    body_en = REPLACE(body_en, 'Hello {{name}},', 'Hello,'),
    variables = JSON_ARRAY()
WHERE `key` = 'contact_ack';

-- C22: a DB-backed daily OTP failure counter per application (UTC day).
-- Ten wrong codes in one day lock OTP sign-in for that application until
-- the next UTC day — unlike the in-memory request limiter, this survives a
-- restart and is shared by every way of naming the application
-- (reference, email, phone).
ALTER TABLE applications
  ADD COLUMN otp_fail_date DATE NULL AFTER consent_at,
  ADD COLUMN otp_fail_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER otp_fail_date;
