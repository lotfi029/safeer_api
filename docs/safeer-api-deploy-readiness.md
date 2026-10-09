# safeer_api — Deploy readiness

**Date:** 2026-09-28
**Reviewed:** `fix/delivery-followups-2` @ `7e4792a` (the code of tag `v1.0.0-rc1` plus one test fix). `main` is still at `a8a8454`: **PR #6 (A5–A12) isn't merged yet.**

## 1. Verdict

**The backend is ready to deploy** once PR #6 is merged and the two small prep items in §4 are done. There are no open functional or security findings.

| Check | Result |
|---|---|
| Tests | 508/508; the A10 lock test passed 10/10 repeated runs (MariaDB 10.11 with `SIMULTANEOUS_ASSIGNMENT` on) |
| Smoke / schema / openapi / role gate | 14/14 · 39 tables match · up to date · every admin route gated |
| Frontend contract | `safeer_web` passes 141/141 e2e against this API |
| **Production dry run** (done today, see §3) | ✅ everything passes |

## 2. Database: MySQL 8.4 LTS (decided 2026-09-28)

**The project database is MySQL**, and the target is **MySQL 8.4 LTS** (8.0 reached end of life in April 2026).

- **It's verified on real MySQL.** On MySQL 8.0.46 in strict mode, including `ONLY_FULL_GROUP_BY`, everything passed:
  - API: 508/508 tests, smoke 14/14, `schema:check`, and the production dry run with a least-privilege user
  - Frontend (the Phases 7–10 stack): **276/276** e2e against that API
- **It changes the hosting choice.** Hostinger web, cloud and Node.js hosting offer only MariaDB. MySQL, like PostgreSQL, needs a **VPS**. So option A in §5 is now **required**, not just recommended: MySQL 8.4 in Docker, or from Oracle's apt repository, bound to `127.0.0.1`.
- The earlier MariaDB work stays harmless. The code is DB-neutral, and the switch prompt (`safeer-mysql-switch-prompt.md`) moves compose, CI and the docs to `mysql:8.4`.

## 3. Production dry run (done locally today)

This follows `docs/backend/DEPLOYMENT-HOSTINGER.md` §First-deploy exactly.

| Step | Result |
|---|---|
| Fresh DB, `NODE_ENV=production npm run migrate` with `MIGRATION_DB_*` | ✅ 19 migrations. **No dev fixtures**: 0 applications, partners, users and media. A second run does nothing. `schema:check` matches. |
| `scripts/create-app-db-user.sql` (least-privilege user on `127.0.0.1`) | ✅ Grants applied |
| Boot with **the least-privilege user**, `NODE_ENV=production` | ✅ `/health/ready` → db up, storage up |
| Public `GET /api/v1/site` | ✅ 200 |
| Swagger `/api/docs` | ✅ 404 (disabled in production) |
| Dev hooks `__dev/otp`, `__dev/settle` | ✅ 404 (A8) |
| Bootstrap admin login | ✅ 201 · cookie `HttpOnly; Secure; SameSite=Strict` · HSTS + CSP + nosniff |
| Write path with the least-privilege user: contact submit, then audit row | ✅ 201; the rows are written |

## 4. Before deploying: 2 small code/doc items (prompt: `safeer-api-deploy-prep-prompt.md`)

**D1 — `trust proxy` is hardcoded to `1`** (`src/main.ts:31`). The number of proxies in front of the API depends on where it's hosted. If the count is wrong, the API sees every visitor with the same IP, which breaks the per-IP limits (5 applications/h, OTP, contact) and the IP hashes. Make it `TRUST_PROXY`, validated in `env.ts` with a default of 1, and test it.

**D2 — The deployment guide doesn't say where the API runs relative to the frontend.** The frontend was built to call the API **privately** (`API_INTERNAL_URL`, with the API reachable only from the SSR server, and the client IP forwarded as `X-Forwarded-For`). The guide must state the topology and the matching `TRUST_PROXY`, `CORS_ORIGINS` and `FRONTEND_BASE_URL` for each option (see §5).

**Also:**
- Merge PR #6.
- Tag the merge commit **`v1.0.0`**, and deploy exactly that tag.
- Point the frontend's `SAFEER_API_REF` at `v1.0.0`. The contract is the same as rc1.

## 5. Hosting decision you need to make

| | **A. Hostinger VPS** (**required with MySQL**) | **B. Hostinger managed Node.js hosting** |
|---|---|---|
| How it runs | Nginx → the frontend SSR app (PM2) → the API on `127.0.0.1:3900` (PM2) → MySQL 8.4 on localhost | Two separate Node.js apps (e.g. `safeer-sa.org` and `api.safeer-sa.org`) behind LiteSpeed, plus hPanel MariaDB |
| Matches the security design | ✅ Exactly. The API is private, `TRUST_PROXY=1`, the client IP is correct, and the API has no public attack surface. | ⚠️ The API is public. The frontend's proxy reaches it through LiteSpeed, so `TRUST_PROXY` must be verified on staging, and a public API lets callers send their own `X-Forwarded-For`. |
| Backups, cron, uploads | Full control (mysqldump, storage tar, offsite copy) | Limited cron. Uploads must live outside the app folder. |
| Node version | Whatever you install (Node 24 for building the frontend; the API runs on 22 or 24) | Only what hPanel offers. Check that it offers ≥ 22.22 before choosing. |
| Effort | You manage the OS (updates, firewall, TLS through certbot) | Less ops, more constraints |

**With the MySQL decision, B is off the table** unless you use an external managed MySQL. That would bring back the public-API and proxy-trust issues, so go with **A**.

## 6. Deploy order (once D1 and D2 are merged and tagged `v1.0.0`)

1. **Infrastructure:**
   - a Hostinger VPS with MySQL 8.4 on `127.0.0.1` and a DDL user (`MIGRATION_DB_*`)
   - the least-privilege app user
   - `STORAGE_ROOT` outside the app folder
   - HTTPS
2. **Secrets:**
   - generate `APP_ENCRYPTION_KEY` and `IP_HASH_SALT`, and keep an offline copy of the key; losing it makes stored ID numbers unreadable
   - set the real bootstrap admin
   - the SMTP settings (in the admin UI after first login)
   - the Unifonic account (or keep SMS off, and OTP falls back to email)
3. **Deploy:** `npm ci && npm run build`, `npm run migrate` (production), `npm run schema:check`, then start with PM2 using `ecosystem.config.cjs` (1 instance).
4. **Verify:** the curl checks from the guide's §Verification, plus the §3 checks above.
5. **Enable:** the backup crons for the DB and storage, and do one test restore.
6. **Deploy `safeer_web`** (after Stage 2), pointing `API_INTERNAL_URL` at the API.
7. **Staging acceptance:** one full real journey: apply → OTP → documents → review → interview → decision.

## 7. Still owed by the client (not blocking the API deploy)

- the production domain
- the SMS provider account
- the official logo SVG, real impact numbers and photos, and the partner list
- the SMTP mailbox credentials

Sources: [Hostinger — Which DBMS is used](https://www.hostinger.com/support/1583226-which-database-management-system-is-used-at-hostinger/), [Hostinger — Supported databases](https://www.hostinger.com/support/which-databases-and-data-tools-are-supported-at-hostinger/), [Hostinger — MySQL with Node.js apps](https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/)
