-- deploy/create-app-db-user.sql — the least-privilege account the API runs as,
-- for the Docker deploy (docs/backend/DEPLOYMENT-VPS.md). Same grants as
-- scripts/create-app-db-user.sql (which stays as-is for bare hosts, where the
-- account is bound to 127.0.0.1); see that file for why each grant is what it is.
--
-- Host '%', not '127.0.0.1' (review B3): in Docker the API connects from its
-- container's address on the private `safeer` network, which a 127.0.0.1
-- account refuses. '%' is safe here only because the db service publishes no
-- port — nothing outside that network can reach MySQL at all. Never publish
-- the db port with this account in place.
--
-- Run it AFTER `docker compose run --rm migrate`: the table-level GRANTs need
-- the tables to exist. Then run `schema:check` as this user.
--
-- Assumes DB_NAME=safeer (every GRANT names `safeer.`). Replace the password
-- placeholder on the way in rather than editing this file:
--
--   sed "s/CHANGE_ME_BEFORE_USE/$APP_DB_PASSWORD/" deploy/create-app-db-user.sql \
--     | docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'
--
-- (The root password is read inside the container from its own env, so it
-- never appears on the host's command line.) The password must not contain
-- `/`, `&` or `'`, or the sed/SQL quoting breaks; the generator in
-- deploy/app.env.example (hex) never produces them.
--
-- Verify:
--   SHOW GRANTS FOR 'safeer_app'@'%';
--   -- no DDL anywhere; only SELECT/INSERT on audit_log; nothing on
--   -- schema_migrations or typeorm_metadata.
--
-- Keep the table list in step with scripts/create-app-db-user.sql — add a line
-- to both for any table a future migration creates.

CREATE USER IF NOT EXISTS 'safeer_app'@'%' IDENTIFIED BY 'CHANGE_ME_BEFORE_USE';

-- 3.1 Accounts
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.users               TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sessions            TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.auth_tokens         TO 'safeer_app'@'%';
-- Append-only by design (AuditInterceptor never updates or deletes a row).
GRANT SELECT, INSERT ON safeer.audit_log TO 'safeer_app'@'%';

-- 3.2 Files
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_assets        TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_variants      TO 'safeer_app'@'%';

-- 3.3 Messaging
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_settings       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_templates      TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_log            TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_settings        TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_templates       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sms_log             TO 'safeer_app'@'%';

-- 3.4 Site
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.site_settings       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.pages               TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.page_sections       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.redirects           TO 'safeer_app'@'%';

-- 3.5 Content
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.stats               TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.about_items         TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.work_areas          TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.work_area_items     TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.board_members       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.news_categories     TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.posts               TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.newsletter_subscribers TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.contact_messages    TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.message_replies     TO 'safeer_app'@'%';

-- 3.6 Voices and partners
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.testimonial_themes  TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.testimonials        TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.partners            TO 'safeer_app'@'%';

-- 3.7 Documents
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.doc_categories      TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.documents           TO 'safeer_app'@'%';

-- 3.8 Scholarships (the apply flow, admin review, and the OTP student portal)
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applications          TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_documents TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_notes     TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.application_events    TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.interview_slots       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applicant_sessions    TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.applicant_otps        TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.counters              TO 'safeer_app'@'%';

-- Deliberately no grant at all on schema_migrations or typeorm_metadata —
-- the running app never touches either table; only `npm run migrate` does,
-- under the separate, more privileged DB_USER.

FLUSH PRIVILEGES;
