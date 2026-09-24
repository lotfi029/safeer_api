-- scripts/create-app-db-user.sql — a least-privilege MySQL account for the
-- running application, separate from the account `npm run migrate` uses.
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
-- Usage (as a privileged/root MySQL user):
--   mysql -u root -p < scripts/create-app-db-user.sql
-- Then set DB_USER/DB_PASSWORD in the running process's .env to the values
-- below (change the password first — this file will likely end up
-- committed, so treat the placeholder as public, same as every other
-- secret in the repo per 20-production-deploy-checklist.md).
--
-- Verify after running:
--   SHOW GRANTS FOR 'safeer_app'@'%';
--   -- must show no DDL (CREATE/ALTER/DROP/INDEX) anywhere, and only
--   -- SELECT/INSERT on audit_log specifically.
--
-- Assumes the database name is `safeer` (.env.example's DB_NAME) —
-- find-and-replace both `safeer.` (the schema prefix on every GRANT
-- below) and the account password if your deployment uses a different one.
--
-- TODO(phase 2+): this lists only the tables that exist after the
-- skeleton-port phase (accounts, files, redirects, messaging). Add a GRANT
-- line here for every table 001_schema.sql adds from phase 2 onward
-- (site content, applications, sms_*, site_settings, ...), mirroring
-- african_api's create-app-db-user.sql for the full shape this should
-- grow into.

CREATE USER IF NOT EXISTS 'safeer_app'@'%' IDENTIFIED BY 'CHANGE_ME_BEFORE_USE';

GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.users               TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.sessions            TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.auth_tokens         TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_assets        TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.media_variants      TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.redirects           TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_settings       TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_templates      TO 'safeer_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON safeer.mail_log            TO 'safeer_app'@'%';

-- Append-only by design (AuditInterceptor never updates or deletes a row).
GRANT SELECT, INSERT ON safeer.audit_log TO 'safeer_app'@'%';

-- Deliberately no grant at all on schema_migrations or typeorm_metadata —
-- the running app never touches either table; only `npm run migrate` does,
-- under the separate, more privileged DB_USER.

FLUSH PRIVILEGES;
