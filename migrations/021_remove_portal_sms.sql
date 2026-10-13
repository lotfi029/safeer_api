-- 021_remove_portal_sms.sql
-- feat/governance-contact (A4): the owner removed the scholarship feature
-- (apply flow, OTP applicant portal, application review, interview slots,
-- the `scholarships` page), SMS and the `reviewer` staff role, and changed
-- the contact form's subjects. This is the database half; the code went in
-- A2/A3 (and A5 for the contact form). Forward-only, MySQL 8.4.
--
-- It runs after migrations/dev/003_dev_sample.sql in development/test
-- (migrate.mjs sorts every file by its bare name, and 003 < 021), so the
-- dev fixtures it inserted into the feature tables are dropped here too.
--
-- DDL commits implicitly, so the guard comes first: it fails the whole file
-- before any statement has changed anything.

-- 1. Guard: no staff account may still hold the `reviewer` role. Reassign or
--    disable-and-reassign such accounts first (PATCH admin/users/:id with
--    role editor/support/admin), then re-run migrate. The CHECK's name is the
--    error message: "Check constraint '021_reassign_reviewer_users_first' is
--    violated."
CREATE TEMPORARY TABLE tmp_021_guard (
  reviewer_users INT NOT NULL,
  CONSTRAINT `021_reassign_reviewer_users_first` CHECK (reviewer_users = 0)
);
INSERT INTO tmp_021_guard (reviewer_users) SELECT COUNT(*) FROM users WHERE role = 'reviewer';
DROP TEMPORARY TABLE tmp_021_guard;

-- 2. The reviewer role.
ALTER TABLE users MODIFY role ENUM('admin','editor','support') NOT NULL DEFAULT 'editor';

-- 3. The scholarship tables, children first (every child FK points at
--    applications), then SMS.
DROP TABLE IF EXISTS applicant_otps;
DROP TABLE IF EXISTS applicant_sessions;
DROP TABLE IF EXISTS application_documents;
DROP TABLE IF EXISTS application_events;
DROP TABLE IF EXISTS application_notes;
DROP TABLE IF EXISTS interview_slots;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS counters;
DROP TABLE IF EXISTS sms_log;
DROP TABLE IF EXISTS sms_templates;
DROP TABLE IF EXISTS sms_settings;

-- 4. The settings that only drove the scholarship notifications/numbering.
ALTER TABLE site_settings
  DROP COLUMN notify_email_on_status_change,
  DROP COLUMN notify_sms_on_status_change,
  DROP COLUMN application_ref_prefix;

-- 5. The feature's mail templates.
DELETE FROM mail_templates WHERE `key` IN (
  'application_started', 'application_submitted', 'application_status_changed', 'application_resume',
  'document_rejected', 'documents_requested', 'otp_code',
  'interview_booked', 'interview_cancelled', 'interview_updated'
);

-- 6. The scholarships page (its sections first, though fk_sections_page
--    cascades anyway) and the scholarship-only about items. care_pillar
--    stays: the home page's "student care" block reads it.
DELETE FROM page_sections WHERE page_id IN (SELECT id FROM (SELECT id FROM pages WHERE slug = 'scholarships') p);
DELETE FROM pages WHERE slug = 'scholarships';
DELETE FROM about_items WHERE kind IN ('scholarship_step', 'requirement');
ALTER TABLE about_items MODIFY kind ENUM('vision','mission','goal','care_pillar') NOT NULL;

-- 7. Buttons that pointed at the removed pages now point at the contact page.
UPDATE page_sections SET primary_button_url = '/contact'
WHERE primary_button_url REGEXP '^/(apply|portal|scholarships)([/?#]|$)';
UPDATE page_sections SET secondary_button_url = '/contact'
WHERE secondary_button_url REGEXP '^/(apply|portal|scholarships)([/?#]|$)';

-- 8. Contact subjects: scholarship → inquiry, plus a new `support` (support
--    and donations). Widen, move the rows, then narrow.
ALTER TABLE contact_messages
  MODIFY subject ENUM('scholarship','inquiry','partnership','support','feedback','other') NOT NULL;
UPDATE contact_messages SET subject = 'inquiry' WHERE subject = 'scholarship';
ALTER TABLE contact_messages
  MODIFY subject ENUM('inquiry','partnership','support','feedback','other') NOT NULL;
