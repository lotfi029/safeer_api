# Safeer — VPS deploy review

**Date:** 2026-10-09
**Target:** a Hostinger VPS (KVM 2: 2 vCPU, 8 GB, Ubuntu 26.04, IP `<VPS_IP>`)

> **Redacted copy.** This repository is public, so the VPS's address, its firewall state and the
> details of other projects on it are left out. The full review is kept with the project's private notes.
**Reviewed:**
- `safeer_api`: `fix/delivery-followups-2` @ `7e4792a` (rc1 + one test fix; `main` is still `a8a8454`)
- `safeer_web`: `perf/lighthouse-ci` @ `99ac5b4` (the tip of the stacked Phase 7–10 branches; `main` is still Phase 6)

**Supersedes** the hosting part of `safeer-api-deploy-readiness.md` (2026-09-28). The VPS is chosen, and it is already running other things (§2), so the Nginx + PM2 plan in both runbooks no longer fits.

---

## 1. Verdict

**Not ready to deploy yet.** The code itself is in very good shape: every test suite passes, and the production dry run of the API passes. What's missing is around it:

1. Nothing has been merged. Web `main` has no admin area.
2. A real SSR bug that only appears with a real domain (§3, B2).
3. There's no way to run it on this VPS yet: no Dockerfiles, no compose file, no Caddy block (§2).

All three are fixable in one API session and one web session. The prompts are in `safeer-vps-deploy-prompt.md`.

| Check (run today) | Result |
|---|---|
| API build, lint, `migrate` twice, `schema:check` | ✅ 20 migrations. The second run does nothing. 39 tables match. |
| API tests | ✅ **508/508** (MySQL 8.0.46, strict mode + `ONLY_FULL_GROUP_BY`, server clock UTC+3) |
| API `openapi:check`, `check:admin-roles`, smoke | ✅ up to date · all gated · **14/14** |
| API production dry run (least-privilege user, `NODE_ENV=production`) | ✅ 19 migrations, no dev fixtures. `/health/ready` up. Swagger and `__dev` routes 404. Login 201 with an `HttpOnly; Secure; SameSite=Strict` cookie, HSTS and CSP. |
| Web lint (eslint, styles, prettier) | ✅ |
| Web unit and server tests | ✅ **225/225** and **123/123** |
| Web `build:ci` | ✅ initial JS 139.8 KB gzip (limit 150). Prod-artifact check OK. |
| Web server bundle runs with no `node_modules` | ✅ `/healthz` 200, pages 200, proxy 200, wrong `Host` → 400 |
| Web e2e against the real API | ✅ **276/276** in 10.7 min (2 workers, API booted as `NODE_ENV=test` with its dev seed) |
| `npm audit` | ⚠️ see S3. Nothing exploitable at runtime that I could find. |

MySQL **8.4** itself couldn't be tested here, because the sandbox can't pull the image. CI will prove it once the switch (S4) is in.

---

## 2. What's already on the VPS (from the Hostinger API)

| Docker project | Containers | Ports |
|---|---|---|
| `edge` (`/srv/edge`) | `caddy:2` | **publishes 80 and 443** (tcp+udp, IPv4+IPv6) |
| another project | api and web (GHCR images), `mysql:8.4` | none published (behind Caddy) |

- The Hostinger firewall rules are covered by S6 (`DEPLOYMENT-VPS.md`).
- `safeer-sa.org` is **not in this Hostinger account**. It currently serves the association's WordPress site, so the client (or whoever holds its DNS) has to change the records.

**What this means:** Nginx can't take 80/443, because Caddy already has them. The natural fit is the same pattern as the project already running there:
- Safeer runs as its own Docker project (`/srv/safeer`), with three containers: `mysql:8.4`, `safeer-api` and `safeer-web`.
- The images are built by GitHub Actions and pushed to GHCR.
- One site block is added to the existing Caddy. Only `safeer-web` joins Caddy's network.
- The API and the DB stay on a private network and publish no ports.

```
visitor ─HTTPS─▶ Caddy (edge) ─▶ safeer-web:4000 ─▶ safeer-api:3900 ─▶ safeer-db:3306
                 TLS, sets XFF    TRUST_PROXY=1      TRUST_PROXY=1       mysql:8.4
                 [edge network]   [edge + safeer]    [safeer only]       [safeer only]
```

This keeps the security design intact:
- The API isn't reachable from outside, which also settles **BF-4** for this setup.
- Caddy replaces any client-sent `X-Forwarded-For` by default.
- The SSR server overwrites it again before the API sees it.
- Caddy has no request-body limit, so the 10 MB PDF uploads need no setting. (Nginx would have needed `client_max_body_size`.)

---

## 3. Blockers (must be done before go-live)

### B1 — Nothing is merged or tagged

- **API:** PR #6 (A5–A12) is open, so `main` = `a8a8454`. There's no `v1.0.0` tag.
- **Web:** `main` = Phase 6. The admin area, the official logo and the Lighthouse work sit on **7 stacked branches (27 commits)**:
  `fix/session-1-review` → `feat/phase-7` → `feat/phase-8` → `feat/phase-9` → `feat/phase-10` → `chore/site-logo-content` → `perf/lighthouse-ci`.
  Deploying web `main` today would ship a site with **no admin dashboard**.
- **You do this** (the repos' rules forbid Claude from merging):
  - merge API PR #6
  - merge the web PRs in that order, or retarget the top one to `main`
  - then merge the two fix PRs from the prompt file
  - tag `v1.0.0` on both repos

### B2 — SSR fetches its own data through the public domain (found today)

The SSR server is meant to call the API directly (`API_INTERNAL_URL`, the "W9" design). **It never does.**

What happens:
1. Angular's server platform has a built-in interceptor that turns every relative URL into an absolute one, using the request's own host. `/api/v1/site` becomes `https://safeer-sa.org/api/v1/site`.
2. `InternalApiBackend` only rewrites *relative* `/api/v1…` URLs, so it lets the absolute URL through.
3. The server then fetches the public domain.

Reproduced with the production bundle:

| `PUBLIC_SITE_URL` / Host | What the SSR server fetched | Page |
|---|---|---|
| `http://localhost:4307` (what e2e uses) | `http://localhost:4307/api/v1/site`. That's itself, which proxies on to the API, so it *looks* internal. | 200 |
| `https://safeer-sa.org` | `https://safeer-sa.org/api/v1/site` and `…/home` → `ENOTFOUND` | **503** |

Effects in production:
- **Staging is broken.** With the real domain still pointing at WordPress, every public page asks WordPress for `/api/v1/…` and renders the 503 panel. Same on any staging hostname whose DNS isn't live yet.
- **After cutover it "works" by accident.** Each page view goes out to the internet, back in through Caddy, into SSR again, and only then to the API. That's double the requests and latency, and the site depends on hairpin DNS from inside the container.
- **Why the suite missed it:** every e2e run uses `PUBLIC_SITE_URL=http://localhost:…`, which hides the problem.

**Fix (web):** `internalApiUrl()` must also rewrite an *absolute* URL whose path is under `/api/v1` and whose host is one of the server's allowed hosts. Then add a server test that renders a page with `PUBLIC_SITE_URL=https://safeer.test` and asserts that no fetch goes to that origin. Check that the transfer cache still hits in the browser (W9).

### B3 — There's no way to run it on this VPS yet

- There are no Dockerfiles in either repo.
- There's no compose file, no Caddy block, and no backup crons for Docker.
- Both runbooks describe Hostinger Node.js hosting + MariaDB (API) or LiteSpeed / PM2 (web).
- `scripts/create-app-db-user.sql` grants to `'safeer_app'@'127.0.0.1'`. In Docker the API connects from the network's address, so that user would be refused. Use `'%'`; the DB container isn't published.

Prompt 1 adds `deploy/` to `safeer_api` (compose, `.env.example`, Caddy snippet, backup scripts, `DEPLOYMENT-VPS.md`) and a Dockerfile plus a GHCR workflow to each repo.

### B4 — Owed by the client before go-live

- Who controls **DNS for `safeer-sa.org`**. We need A (and AAAA) records → `<VPS_IP>`, first for a staging name such as `new.safeer-sa.org`, then the apex and `www`.
- **SMTP mailbox credentials.** Without mail, staff invites and password resets can't be sent; only the bootstrap admin can sign in.
- The **real first admin** email.
- Unifonic (optional at launch: OTP falls back to email).

---

## 4. Should fix before go-live

| # | Item | Why |
|---|---|---|
| **S1** | **BF-2:** retry the `POST /applications` transaction on `ER_LOCK_DEADLOCK` (up to 3 tries) | Two applicants submitting at the same moment: one gets a 500 "Database error". It was seen in CI, and there's no retry in the API. Real users will hit it during an application window. |
| **S2** | Add `TRUST_PROXY` (D1) and `HOST` (BF-4) env vars to the API, and `HOST` to the web server | 1 is correct for this topology, so this is hardening, not a bug. `HOST` defaults to `127.0.0.1` on a bare host; compose sets `0.0.0.0` inside the containers. |
| **S3** | `npm audit fix` (non-breaking) in both repos | Details below this table. |
| **S4** | Switch compose and CI to `mysql:8.4` (the switch prompt was never applied: both are still `mysql:8.0`). Drop the MariaDB leg. | Production is 8.4. CI should prove it. |
| **S5** | Web cleanup: `.env.example` says `API_INTERNAL_URL=…:3000`, but the API runs on **3900**. After the tag, set `SAFEER_API_REF=v1.0.0` and refresh `docs/api/`. | |
| **S6** | Attach a Hostinger firewall to the VPS: allow 22 (ideally your IP only), 80, and 443 tcp+udp | Docker-published ports bypass `ufw`, so the Hostinger firewall is the reliable layer. |
| **S7** | Check on staging that the API sees **real client IPs** over both IPv4 and IPv6 | Two ways to check: submit the contact form twice from two networks and compare `ip_hash`, or read the API log. If IPv6 visitors all show the Docker gateway address, enable `ip6tables` in `/etc/docker/daemon.json`. Otherwise every IPv6 visitor shares one rate limit. |
| **S8** | SSR server: e2e logged `MaxListenersExceededWarning: 11 timeout listeners added to [Socket]` 41 times | Probably the proxy's `timeout` and `proxyTimeout` adding a listener per request on a reused keep-alive socket. That's a slow leak under steady traffic. Reproduce it with a load test of `/api/v1/site` through the SSR server, then fix it, e.g. keep only `proxyTimeout`. Watch memory after launch; `max_memory_restart` doesn't apply in Docker. |

**S3 — `npm audit`, in detail:**

- **`sharp` 0.35.4 → 0.35.5 (both repos).** There's a librsvg CVE, but SVG uploads are rejected by the API's allow-list, so it isn't reachable. Patch anyway.
- **API dev tooling** (`concurrently` → `shell-quote`, `ts-jest` → `handlebars`) is critical on paper, but none of it runs in production. Note: `.npmrc include=dev` puts it on the server anyway; the Dockerfile's runtime stage should drop it.
- **Web, `http-proxy-middleware` → `micromatch` → `braces`:** no fixed version exists. It's not exploitable here, because the only patterns are the static `/api/**` and `/files/**`. Record it as accepted.
- **Web `lighthouse` chain:** dev only, and the fix is a major bump. Leave it until after launch.

---

## 5. Deploy runbook (once B1–B3 are merged and tagged `v1.0.0`)

1. **Firewall** (S6). Confirm `docker login ghcr.io` works on the VPS.
2. `mkdir /srv/safeer`. Copy `deploy/docker-compose.yml` and write `.env` (`chmod 600`):
   - generate `APP_ENCRYPTION_KEY`, `IP_HASH_SALT`, the DB root, migration and app passwords, and the bootstrap admin password
   - **store `APP_ENCRYPTION_KEY` offline** (password manager). Losing it makes applicant ID numbers unreadable.
   - for staging: `PUBLIC_SITE_URL` = `FRONTEND_BASE_URL` = `CORS_ORIGINS` = `https://new.safeer-sa.org`
3. Database:
   - `docker compose up -d db`
   - `docker compose run --rm migrate`, using the migration user
   - create the app user (`deploy/create-app-db-user.sql`, host `%`); its table grants need the tables to exist
   - then `npm run schema:check` as the app user
4. Start the app and add the site:
   - `docker compose up -d api web`
   - add the Caddy block for the staging host
   - `docker exec edge-caddy-1 caddy reload --config /etc/caddy/Caddyfile`
5. **Verify** (`DEPLOYMENT-VPS.md` §Verification):
   - `/healthz` and `/api/v1/site` through the domain
   - CSP and HSTS headers
   - admin login
   - port 3900 not reachable from outside
   - S7
6. **Staging acceptance:**
   - one real journey: apply → OTP (email) → documents → review → interview → decision
   - configure SMTP in the admin and send a test
   - then delete the test application from the admin, which anonymises it
7. **Backups:**
   - enable the host crons: `mysqldump` through `docker compose exec`, and a tar of the storage volume, both 14 days
   - set up an encrypted offsite copy
   - **do one test restore**
8. **Cutover:**
   - switch the three URLs in `.env` to `https://safeer-sa.org`, then `docker compose up -d`
   - add the apex + `www` Caddy block (redirect `www` to the apex)
   - the client points the DNS
   - keep a backup of the WordPress site; legacy URLs are already redirected (Phase 2)
9. **After launch:**
   - an uptime monitor on `/healthz` and `/api/v1/site`
   - enter the real content (`docs/frontend/client-content.md`)
   - invite the staff

## 6. After launch (not blocking)

- **Content.** Figures (200 beneficiaries, pending client confirmation), the map pin, the Facebook and Instagram URLs, partners, photos, programmes/events, the registration certificate PDF.
- **Unifonic.** Not yet tested against the live provider. Run `POST admin/sms/test` once the account exists.
- **Repo visibility.** Both repos are public (they clone without auth). I found no real secrets in their history, only CI-only keys. Make them private if the client prefers. GHCR images then need the VPS login, which it already has.
- **Web dev dependencies.** A major `lighthouse` bump, plus the accordion-heading a11y item from HANDOFF.
