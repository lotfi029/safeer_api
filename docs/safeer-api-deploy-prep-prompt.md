# Prompt — safeer_api: deploy prep (D1, D2) and release v1.0.0

> **Before pasting:** merge PR #6 into `main`.
> Then run Claude Code on `safeer_api` and paste everything below the line.

---

You are preparing **safeer_api** for its first production deploy. A deploy-readiness review (`docs/safeer-api-deploy-readiness.md`) ran the full production path on a fresh MariaDB 10.11:
- production migrate
- a least-privilege app user
- a production boot, with Swagger and the dev hooks returning 404
- `Secure`/`HttpOnly`/`SameSite=Strict` cookies
- security headers
- the write path

Everything passed. Two small items remain. Do both on branch `release/v1.0.0` from the updated `main`, in one draft PR.

## Read first
- `docs/safeer-api-deploy-readiness.md`: §4 has the items, §5 the hosting options.
- `docs/backend/DEPLOYMENT-HOSTINGER.md`, `src/main.ts`, `src/config/env.ts`, `ecosystem.config.cjs`.

## D1 — `TRUST_PROXY` as config
- `src/main.ts:31` hardcodes `app.set('trust proxy', 1)`. Make it read `TRUST_PROXY` from `env.ts`. Accept either:
  - an integer hop count, 0–5, default `1`
  - or a comma-separated list of IPs/CIDRs, which Express accepts natively, for when the upstream proxy addresses are known
- Validate it at boot: an invalid value refuses to start with a clear message.
- Add it to `.env.example` and the README env table.
- **Tests:**
  - A unit test for the env parsing.
  - An e2e test that sends requests with `X-Forwarded-For: <a>, <b>` and checks which IP the API records (for example the `ip_hash` of a contact message, compared with the expected salted hash), with `TRUST_PROXY=1` and `=2`.
  - Existing tests must still pass with the default.

## D2 — Topology in the deployment guide
Add a section **"Where the API runs (topology)"** to `docs/backend/DEPLOYMENT-HOSTINGER.md`, near the top, with both options from readiness §5:

- **A. Hostinger VPS (recommended)**
  - nginx → frontend SSR (PM2) → API on `127.0.0.1:3900` (PM2, `HOST=127.0.0.1`) → MariaDB on localhost.
  - Settings: `TRUST_PROXY=1`, `CORS_ORIGINS` = the site origin, and the frontend's `API_INTERNAL_URL=http://127.0.0.1:3900`.
  - Include a minimal nginx server block for the site. The API isn't exposed.
  - Include the firewall rule: only 80/443/SSH open.
  - If the API doesn't already support a bind host, add `HOST` (default `0.0.0.0`) to `env.ts` so it can listen on `127.0.0.1` only.
- **B. Hostinger managed Node.js hosting**
  - Two apps (site plus an API subdomain), with hPanel MariaDB.
  - State plainly that the API is publicly reachable there, so a caller can send its own `X-Forwarded-For`.
  - Give a **staging check** for the right `TRUST_PROXY`: call a debug-free endpoint through the frontend and directly, then compare the recorded `ip_hash` values with the expected client IP.
  - Say that per-IP limits are only as reliable as that setting.
  - Note the Node version requirement: the API runs on ≥ 22.22; hPanel must offer it.

Also add:
- a **"Release and rollback"** subsection: deploy only a tag; roll back by redeploying the previous tag; migrations are forward-only, so take the pre-deploy DB backup first
- one line on why MariaDB: Hostinger web/Node hosting offers only MariaDB, PostgreSQL is VPS-only, and CI tests MySQL 8 + MariaDB 10.11

## Release
1. Gate:
   - `npm run build && npm run lint && npm test && npm run openapi:check && npm run check:admin-roles`
   - `npm run migrate` twice, then `schema:check`
   - smoke
2. Record D1/D2 in `docs/backend/FIX-PLAN-STATUS.md`, and add `TRUST_PROXY` (plus `HOST` if added) to `docs/backend/API-CHANGES.md` as ops-only changes.
3. Push the branch and open the draft PR. **Don't merge and don't tag.** When I've merged it, I'll tag `v1.0.0` on the merge commit and point `safeer_web`'s `SAFEER_API_REF` at it.
4. Never force-push, never touch production, never commit secrets.

Stop after opening the PR and report: the gate numbers, what changed, and the final list of production env vars.
