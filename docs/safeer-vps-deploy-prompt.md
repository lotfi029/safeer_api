# Prompts — Safeer VPS deploy fixes

> Redacted copy (public repo). The API session ran with the corrections C1–C11 recorded in
> `docs/backend/FIX-PLAN-STATUS.md` (VPS deploy); in particular it retries only deadlocks (1213), not
> lock-wait timeouts (1205).

Two Claude Code sessions, one per repo. Run **Prompt 1 (safeer_api) first**: Prompt 2 pins the web CI to the API tag it produces.

**Before each session:**
- Merge what's pending (review §3 B1):
  - API PR #6
  - the web stack `fix/session-1-review` → … → `perf/lighthouse-ci` into `main`
- Copy `safeer-vps-deploy-review.md` into the repo's `docs/`, because the cloud session reads the repo, not this folder.

---

## Prompt 1 — safeer_api

```text
You are working in the safeer_api repo (NestJS 11 + TypeORM + MySQL). Read CLAUDE.md and
docs/safeer-vps-deploy-review.md first. Follow CLAUDE.md's rules: branch + PR, never merge, never
force-push main, `npm run build && npm run lint && npm test && npm run openapi:check` before every
commit, new numbered migrations only.

Goal: make the API deployable on the Hostinger VPS as a Docker project behind the VPS's existing
Caddy container, on MySQL 8.4. Branch: `chore/vps-deploy` from main (PR #6 is already merged).

The VPS (read-only facts, don't change them from here):
- Ubuntu 26.04, Docker. An `edge` compose project at /srv/edge runs caddy:2 and publishes 80/443.
  Another project runs api/web/mysql:8.4 from GHCR images behind that Caddy.
- The name of Caddy's Docker network is not known here: make it a variable (EDGE_NETWORK) and
  document `docker network ls` / /srv/edge/docker-compose.yml to find it.

Do, one commit per item:

1. BF-2 / S1 — `ApplicationsService.create`: retry the whole transaction on ER_LOCK_DEADLOCK (errno
   1213) and ER_LOCK_WAIT_TIMEOUT (1205), up to 3 attempts with a small jittered backoff. Never retry
   after the commit; mail is still sent only after commit. Test: fire N concurrent creates (N ≥ 6,
   distinct applicants) and assert all succeed with distinct references, none 500.

2. D1 + BF-4 / S2:
   - `TRUST_PROXY` (int 0–10, default 1) replaces the hardcoded `app.set('trust proxy', 1)`.
   - `HOST` (default `127.0.0.1`) is passed to `app.listen(PORT, HOST)`.
   - Validate both in src/config/env.ts, add them to .env.example and the README env table, and test them.
   - In CI and the Jest global setup, set whatever HOST the tests need.

3. S4 — MySQL 8.4:
   - docker-compose.yml (dev) and the CI matrix use `mysql:8.4`. Drop the MariaDB leg; production is
     MySQL now.
   - Fix any comment that still says production runs on MariaDB (KNOWN-ISSUES.md, ci.yml, README).
   - Keep the code DB-neutral.

4. S3 — `npm audit fix` (no --force). sharp must end at ≥ 0.35.5. Report what's left and why.

5. Dockerfile (multi-stage, Node 24 slim, glibc for argon2/sharp):
   - Build stage: `npm ci`, `npm run build`.
   - Runtime stage: production deps only. Note `.npmrc` has `include=dev`, so override it (e.g.
     `npm ci --omit=dev --include=prod`, or remove .npmrc in that stage) and check that `nest`,
     `typescript`, `jest` and `concurrently` are absent from the final image.
   - Copy dist/, migrations/, scripts/, package*.json.
   - Run as the `node` user. ENV NODE_ENV=production, HOST=0.0.0.0, PORT=3900.
     STORAGE_ROOT=/data/storage (a volume).
   - HEALTHCHECK on /health. CMD `node dist/main.js`.
   - .dockerignore: node_modules, dist, var, .env*, docs, test, .git.
   - Prove it: build the image, run it against a MySQL 8.4 container, `npm run migrate` through
     `docker run --rm … npm run migrate`, and check that /health/ready is up.
   - `npm run migrate`, `schema:check` and `backup:storage` must work inside the image.

6. GitHub Actions `image.yml`:
   - On a `v*` tag (and manual dispatch), build and push `ghcr.io/lotfi029/safeer-api:<tag>` and
     `:sha-<short>`.
   - permissions: contents read, packages write. Pin actions to SHAs like ci.yml.

7. `deploy/` (the deploy bundle for the whole stack; it lives in this repo):
   - `docker-compose.yml`, project name `safeer`, three services:
     - `db`: mysql:8.4, utf8mb4_unicode_ci, a named volume, no published ports. Healthcheck.
       Modest `innodb_buffer_pool_size` (the VPS is shared, 8 GB).
     - `api`: `ghcr.io/lotfi029/safeer-api:${SAFEER_API_TAG}`, env from .env, `storage` volume at
       /data/storage, no published ports, depends_on db healthy.
     - `web`: `ghcr.io/lotfi029/safeer-web:${SAFEER_WEB_TAG}`.
       API_INTERNAL_URL=http://api:3900, TRUST_PROXY=1, HOST=0.0.0.0, PORT=4000.
     - Networks: `safeer` (internal: db, api, web) plus the external `${EDGE_NETWORK}` (web only).
     - json-file log rotation (max-size 10m, max-file 5). restart: unless-stopped.
   - `.env.example`: every variable, with how to generate each secret. Point out that
     APP_ENCRYPTION_KEY must be kept offline, and that the CI key from ci.yml must never be reused.
   - `create-app-db-user.sql`: the least-privilege grants from scripts/, for `'safeer_app'@'%'`
     (the DB isn't published). Keep scripts/create-app-db-user.sql for bare hosts.
   - `Caddyfile.safeer`:
     - A block for a staging host (`new.safeer-sa.org`) and one for the apex.
     - The www host redirects to the apex.
     - `reverse_proxy safeer-web-1:4000` (or the service alias on the edge network).
     - No `trusted_proxies`, so Caddy keeps overwriting client-sent X-Forwarded-For. Add a comment
       explaining why.
     - No HTML caching.
   - `backup.sh`:
     - `mysqldump --single-transaction` via `docker compose exec -T db`, with credentials from a
       file, not argv.
     - A tar of the storage volume (reuse `backup:storage` inside the api container if that's
       cleaner).
     - 14-day retention.
     - A cron example. A restore section.

8. `docs/backend/DEPLOYMENT-VPS.md`: the runbook for exactly this (review §5 steps 1–9):
   - first deploy, staging, then cutover
   - updates: pull the new tag, migrate, `up -d`
   - rollback: the previous image tag; database = restore the dump taken before the migration
   - verification: the curl list, plus "port 3900 is not reachable from outside", plus the S7
     IPv4/IPv6 client-IP check
   - backups and the test restore
   - the Hostinger firewall rules (22/80/443)
   Mark DEPLOYMENT-HOSTINGER.md as "superseded for production — kept for reference" at its top.
   Update CLAUDE.md "Read first" and the README.

9. Update docs/backend/FIX-PLAN-STATUS.md / API-CHANGES.md (contract unchanged; note the new env
   vars). Run `npm run openapi` if anything changed.

Done when: CI is green on mysql:8.4, the image builds and passes the step 5 check, and the PR
description lists every item with its commit and test. Open the PR as a draft. Don't tag; the owner
tags v1.0.0 after merging.
```

---

## Prompt 2 — safeer_web

```text
You are working in the safeer_web repo (Angular 22 SSR, zoneless). Read CLAUDE.md,
docs/frontend/HANDOFF.md and docs/safeer-vps-deploy-review.md first. Follow CLAUDE.md's rules (branch
+ draft PR, never merge, real-API e2e, no invented content, never write to ../safeer_api).
Branch: `fix/vps-deploy` from main (the Phase 7–10 stack is already merged).

Do, one commit per item:

1. B2 — SSR must call the API internally:
   - Angular's server platform turns every relative request URL into an absolute one, using the
     request's host (relativeUrlsTransformerInterceptorFn). So InternalApiBackend receives
     `https://<host>/api/v1/…`, `isApiUrl()` is false, and the server fetches its own public domain.
     With PUBLIC_SITE_URL=https://safeer-sa.org and a request with `Host: safeer-sa.org`, the
     production bundle fetched `https://safeer-sa.org/api/v1/site` and answered 503. e2e never saw it
     because it uses localhost (it hits itself and gets proxied).
   - Fix `internalApiUrl()`: also rewrite an absolute http(s) URL whose pathname is `/api/v1` or
     under it, and whose host is one of the server's allowed hosts (PUBLIC_SITE_URL's host + www;
     localhost outside production). Keep the query string.
   - Keep the W9 property: the transfer cache keys on the relative URL, so the browser reuses the SSR
     responses. Verify that with a test.
   - Tests:
     a. unit tests for internalApiUrl (relative, absolute same-host, www, foreign host untouched,
        /api/v10 untouched)
     b. a server test, or an e2e webServer entry, that starts the production bundle with
        PUBLIC_SITE_URL=https://safeer.test, renders /ar with `Host: safeer.test`, and asserts a 200
        and that every SSR fetch went to API_INTERNAL_URL, none to safeer.test (wrap
        globalThis.fetch, or point API_INTERNAL_URL at a recording stub)
     c. the existing e2e suite still passes on mock and real API

2. HOST for the SSR server (S2): `HOST` env (default 127.0.0.1) passed to `app.listen`. Validate it
   in src/server/env.ts and test it. The log line prints the real host.

3. S5:
   - `.env.example` and DEV_DEFAULTS: API_INTERNAL_URL port 3900, not 3000.
   - Add HOST.

4. S3 — `npm audit fix` (no --force); sharp ≥ 0.35.5. Record the accepted http-proxy-middleware →
   micromatch → braces finding (static patterns only, no fixed version) in HANDOFF known issues.

4a. S8 — the real-API e2e logs `MaxListenersExceededWarning: 11 timeout listeners added to [Socket]`
   from the SSR server (41 times in one run).
   - Find the source; the likely one is src/server/proxy.ts setting both `timeout` and `proxyTimeout`
     on reused keep-alive sockets.
   - Fix it without losing the 30 s upstream timeout or the 504/502 problem bodies.
   - Prove it with a short load test (≥ 500 sequential and concurrent requests to /api/v1/site through
     the SSR server): no warning, and flat heap.

5. Dockerfile:
   - Build stage: Node 24.21 (match .nvmrc), `npm ci`, `npm run build`.
   - Runtime stage: Node 24 slim, with only `dist/safeer_web/` (the server bundle needs no
     node_modules; verified). Run as `node`.
   - ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000.
   - HEALTHCHECK on /healthz (it answers whatever the Host header is). CMD
     `node dist/safeer_web/server/server.mjs`.
   - .dockerignore.
   - Prove it: build it, run it with PUBLIC_SITE_URL=https://safeer.test and API_INTERNAL_URL
     pointing at a running API, then curl /ar with `Host: safeer.test` → 200.

6. GitHub Actions `image.yml`: on a `v*` tag and manual dispatch, push
   `ghcr.io/lotfi029/safeer-web:<tag>` and `:sha-<short>`. Pin the actions.

7. docs/frontend/deployment.md: replace the Hostinger Node.js / PM2 topology with the VPS Docker one:
   - the chain is Caddy (edge) → safeer-web → safeer-api → mysql:8.4
   - point to safeer_api `deploy/` and `docs/backend/DEPLOYMENT-VPS.md` for the stack
   - the values that must agree (PUBLIC_SITE_URL = FRONTEND_BASE_URL = CORS_ORIGINS; TRUST_PROXY=1
     on both)
   - the staging → cutover switch
   Keep app.cjs and ecosystem.config.cjs, but mark them as non-Docker options. Update HANDOFF
   (BF-2 and BF-4 are fixed in the API on chore/vps-deploy; B2 is fixed here).

8. After the owner tags safeer_api v1.0.0: set `SAFEER_API_REF` to v1.0.0 (tell the owner to update
   the repo variable), refresh `docs/api/` with `node scripts/snapshot-api.mjs ../safeer_api v1.0.0`,
   and run the real-API e2e. If the tag doesn't exist yet, stop at this item and say so.

Done when: lint, unit, server tests, build:ci and e2e (mock and real API) are green, the Docker check
in item 5 passes, and the draft PR lists each item with its commit and test.
```
