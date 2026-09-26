-- scripts/create-app-db-user.sql — a least-privilege MySQL/MariaDB account
-- for the running application, separate from the account `npm run migrate`
-- uses.
--
-- Two accounts, two jobs:
--   - The DB_USER in .env (whatever ran `npm run migrate`) needs DDL rights
--     to create tables, including schema_migrations and typeorm_metadata
--     (scripts/migrate.mjs creates both itself). Keep using that account
--     only for migrations, never for the running process.
--   - This script creates a second account for the running process, with
--     no DDL rights at all, and no access to schema_migrations or
--     typeorm_metadata — the app never reads or writes either table, only
--     the migration runner does.
--
-- audit_log gets SELECT + INSERT only (the app only ever inserts audit
-- rows via AuditInterceptor — never updates or deletes one, by design:
-- audit_log is append-only). Every other domain table gets the full
-- SELECT/INSERT/UPDATE/DELETE the CRUD kernel and hand-written services
-- actually need.
--
-- Usage (as a privileged/root MySQL/MariaDB user):
--   mysql -u root -p < scripts/create-app-db-user.sql
-- Then set DB_USER/DB_PASSWORD in the running process's .env to the values
-- below (change the password first — this file will likely end up
-- committed, so treat the placeholder as public, same as every other
-- secret in the repo per docs/backend/DEPLOYMENT-HOSTINGER.md's checklist).
--
-- The account is bound to host 127.0.0.1, not '%' (C29): the app connects
-- over TCP to the database on the same server (DB_HOST=127.0.0.1), and a
-- wildcard host would accept the same credentials from anywhere the
-- database port is reachable.
--
-- Verify after running:
--   SHOW GRANTS FOR 'safeer_app'@'127.0.0.1';
--   -- must show no DDL (CREATE/ALTER/DROP/INDEX) anywhere, and only
--   -- SELECT/INSERT on audit_log specifically.
--
-- Assumes the database name is `safeer` (.env.example's DB_NAME) —
-- find-and-replace both `safeer.` (the schema prefix on every GRANT below)
-- and the account password if your deployment uses a different one.
--
-- This list is every table 001_schema.sql creates as of the final phase —
-- accounts/sessions/audit, files, mail/SMS, site content, the scholarship
-- pipeline. Add a line here for any new table a future migration creates.

CREATE USER IF NOT EXISTS 'safeer_app'@'127.0.0.1' IDENTIFIED BY 'CHANGE_ME_BEFORE_USE';

-- 3.1 Accounts
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.users               TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sessions            TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.auth_tokens         TO 'safeer_app'@'127.0.0.1';
-- Append-only by design (AuditInterceptor never updates or deletes a row).
GRANT SELECT, INSERT ON safeer.audit_log TO 'safeer_app'@'127.0.0.1';

-- 3.2 Files
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_assets        TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_variants      TO 'safeer_app'@'127.0.0.1';

-- 3.3 Messaging
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_settings       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_templates      TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_log            TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_settings        TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_templates       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_log             TO 'safeer_app'@'127.0.0.1';

-- 3.4 Site
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.site_settings       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.pages               TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.page_sections       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.redirects           TO 'safeer_app'@'127.0.0.1';

-- 3.5 Content
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.stats               TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.about_items         TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.work_areas          TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.work_area_items     TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.board_members       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.news_categories     TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.posts               TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.newsletter_subscribers TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.contact_messages    TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.message_replies     TO 'safeer_app'@'127.0.0.1';

-- 3.6 Voices and partners
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.testimonial_themes  TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.testimonials        TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.partners            TO 'safeer_app'@'127.0.0.1';

-- 3.7 Documents
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.doc_categories      TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.documents           TO 'safeer_app'@'127.0.0.1';

-- 3.8 Scholarships (the apply flow, admin review, and the OTP student portal)
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applications          TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_documents TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_notes     TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_events    TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.interview_slots       TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applicant_sessions    TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applicant_otps        TO 'safeer_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.counters              TO 'safeer_app'@'127.0.0.1';

-- Deliberately no grant at all on schema_migrations or typeorm_metadata —
-- the running app never touches either table; only `npm run migrate` does,
-- under the separate, more privileged DB_USER.

FLUSH PRIVILEGES;
