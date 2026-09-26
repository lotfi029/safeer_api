-- 004_otp_channels_and_phone.sql
-- safeer-backend-fr-review.md B1 + B2.
--
-- B1: add 'unifonic' as a real sms_settings.driver (alongside the existing
-- 'log'/'http'), so admin/sms/settings can select it.
--
-- B2: add applications.phone_e164 (E.164, backfilled below) so an
-- applicant can be looked up by phone, not just reference/email, and so a
-- duplicate active application can be detected by phone too. The backfill
-- rules mirror src/common/phone.ts's normalizePhone() exactly — keep both
-- in sync if either changes.

ALTER TABLE sms_settings
  MODIFY COLUMN driver ENUM('log','http','unifonic') NOT NULL DEFAULT 'log';

ALTER TABLE applications
  ADD COLUMN phone_e164 VARCHAR(16) NULL AFTER phone,
  ADD KEY ix_applications_phone_e164 (phone_e164),
  ADD KEY ix_applications_email_status (email, status);

-- Backfill phone_e164 from the existing free-text `phone` column, via a
-- wide scratch column (`phone` can be up to 40 chars; phone_e164 is only
-- ever 16) so an intermediate value — before the final "is this really
-- E.164" check below — never overflows the real, narrow column. Applied in
-- order, most-specific pattern first; a row that matches none of them (and
-- isn't already a plausible E.164 number) is left NULL.

ALTER TABLE applications ADD COLUMN phone_e164_scratch VARCHAR(64) NULL;

-- 1) Strip everything but digits and a leading '+'.
UPDATE applications
SET phone_e164_scratch = REGEXP_REPLACE(phone, '[^0-9+]', '')
WHERE phone IS NOT NULL;

-- 2) '00' international prefix -> '+'.
UPDATE applications
SET phone_e164_scratch = CONCAT('+', SUBSTRING(phone_e164_scratch, 3))
WHERE phone_e164_scratch REGEXP '^00[0-9]+$';

-- 3) Local Saudi mobile with a trunk 0 (05XXXXXXXX) -> +9665XXXXXXXX.
UPDATE applications
SET phone_e164_scratch = CONCAT('+966', SUBSTRING(phone_e164_scratch, 2))
WHERE phone_e164_scratch REGEXP '^05[0-9]{8}$';

-- 4) Bare Saudi mobile, no leading 0 or country code (5XXXXXXXX).
UPDATE applications
SET phone_e164_scratch = CONCAT('+966', phone_e164_scratch)
WHERE phone_e164_scratch REGEXP '^5[0-9]{8}$';

-- 5) Country code already present with no '+' (966XXXXXXXXX or any other).
UPDATE applications
SET phone_e164_scratch = CONCAT('+', phone_e164_scratch)
WHERE phone_e164_scratch REGEXP '^[1-9][0-9]+$';

-- 6) Copy into the real column only what actually looks like E.164 (+ then
--    8-15 digits, first digit 1-9, which is also always <= 16 chars) —
--    anything else is unusable as an identifier and stays NULL.
UPDATE applications
SET phone_e164 = phone_e164_scratch
WHERE phone_e164_scratch REGEXP '^\\+[1-9][0-9]{7,14}$';

ALTER TABLE applications DROP COLUMN phone_e164_scratch;

-- New templates for B2's "continue your application" notice, sent when a
-- second active application is attempted for the same email/phone
-- (ApplicationsService.create). INSERT IGNORE: a database re-seeded from a
-- regenerated 002_seed.sql/dev/003_dev_sample.sql (tools/seed-from-prototype.mjs,
-- updated in the same change) already has these rows, so this is a no-op there.

INSERT IGNORE INTO mail_templates (`key`, name_ar, name_en, subject_ar, subject_en, body_ar, body_en, variables, is_enabled, updated_by) VALUES
  ('application_resume', 'متابعة طلب قائم', 'Continue an existing application',
   'لديك طلب منحة قائم بالفعل', 'You already have an application in progress',
   'مرحبًا {{name}}،\n\nلديك طلب منحة قائم بالفعل برقم **{{reference}}**. يمكنك متابعته من بوابة الطالب في أي وقت:\n\n[{{link}}]({{link}})',
   'Hello {{name}},\n\nYou already have a scholarship application in progress, reference **{{reference}}**. You can continue it from the student portal at any time:\n\n[{{link}}]({{link}})',
   '["name","reference","link"]', 1, NULL);

INSERT IGNORE INTO sms_templates (`key`, name_ar, name_en, body_ar, body_en, variables, is_enabled, updated_by) VALUES
  ('application_resume', 'متابعة طلب قائم', 'Continue an existing application',
   'جمعية سفير: لديك طلب قائم برقم {{reference}}. تابعه عبر بوابة الطالب: {{link}}',
   'Safeer: you have an application in progress, ref {{reference}}. Continue it: {{link}}',
   '["reference","link"]', 1, NULL);
