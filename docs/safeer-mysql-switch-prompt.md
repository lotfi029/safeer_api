# Prompt — Make MySQL 8.4 LTS the project database (safeer_api + safeer_web)

> Run **Part A** in a `safeer_api` Claude Code session (after PR #6 is merged). Run **Part B** in a `safeer_web` session. Paste the part below its heading.

---

## Part A — safeer_api

**Decision (final):** the production database is **MySQL 8.4 LTS**. MySQL 8.0 reached end of life in April 2026. MariaDB is no longer a target.

A verification on MySQL 8.0.46 in strict mode, with `ONLY_FULL_GROUP_BY` on, already passed:
- 508/508 tests, smoke 14/14, `schema:check`
- the production dry run with a least-privilege user
- the frontend's real-API e2e: 276/276

Work on branch `chore/mysql-8.4`, as one draft PR:

1. **`docker-compose.yml`:** `mysql:8.0` → `mysql:8.4`. Keep port `127.0.0.1:3308`, the utf8mb4 command and MailHog.
2. **CI (`.github/workflows/ci.yml`):**
   - The DB matrix becomes `mysql:8.4` (required) plus `mysql:8.0` (optional, `continue-on-error`, to be removed later).
   - Remove the MariaDB 10.11 job.
   - Keep the production-path migrate, the second migrate (must do nothing) and `schema:check` on 8.4.
3. **Code:**
   - Keep the UTC guard and the `SIMULTANEOUS_ASSIGNMENT` strip. The strip is harmless on MySQL, which doesn't have that mode, but the check must not fail there. Confirm it doesn't error when the mode is unknown.
   - Grep for anything MariaDB-specific (comments, error-code branches, docs) and make it DB-neutral or MySQL-first. Don't change behaviour.
   - Confirm `mysql2` handles 8.4's default `caching_sha2_password` authentication over TCP, including for the least-privilege user created by `scripts/create-app-db-user.sql`. Add the `IDENTIFIED WITH caching_sha2_password` clause only if needed.
4. **Docs:**
   - **`docs/backend/DEPLOYMENT-HOSTINGER.md`:** replace "Why MariaDB" with **"Database: MySQL 8.4 LTS"**. Explain that Hostinger web, cloud and Node.js hosting offer only MariaDB, so **production runs on a Hostinger VPS** with MySQL 8.4, either in Docker (`mysql:8.4`, bound to `127.0.0.1`, a named volume) or from Oracle's apt repository. Update the first-deploy checklist, the backup commands (`mysqldump --single-transaction` works the same) and the topology (VPS: nginx → web SSR → API on 127.0.0.1 → MySQL on 127.0.0.1).
   - **README:** database prerequisites are MySQL 8.4. Add the local Docker command.
   - **`KNOWN-ISSUES.md` and `ARCHITECTURE.md`:** remove the MariaDB-first wording.
   - Record the change in `docs/backend/API-CHANGES.md` as ops-only.
5. **Gate:** build, lint, `npm test`, `openapi:check`, `check:admin-roles`, migrate twice, `schema:check`, smoke. Run all of it **against a local `mysql:8.4` container**, and report the exact server version. Push the branch and open the draft PR. Don't merge and don't tag.

## Part B — safeer_web

Branch `chore/mysql-8.4` from the current stack tip (`perf/lighthouse-ci`), as a draft PR against it:

1. **`.github/workflows/ci.yml`, job `e2e-real`:** the service image becomes `mysql:8.4`.
2. **README "run e2e against the real API locally":** use a `mysql:8.4` container and the MySQL wording. Update `docs/frontend/HANDOFF.md` and `docs/frontend/deployment.md` to match. Production is a VPS with MySQL 8.4 on localhost.
3. **Gate:** lint, unit, server, `build:ci`, e2e against the mock, and e2e against the real API with the API running against a local `mysql:8.4`. Report the counts.

Never touch production, never commit secrets, never force-push.
