# Architecture notes

The short README covers setup, env vars and scripts. This page keeps the
longer notes on how the API is put together.

## Run

```bash
npm run start:dev
```

Compiles with `tsc --watch` and runs `dist/main.js` under `nodemon`,
restarting on every rebuild. `npm run build && npm run start:prod` runs the
same compiled output without the watch loop, the way production does (see
[`DEPLOYMENT-HOSTINGER.md`](DEPLOYMENT-HOSTINGER.md)).

Once running:
- `GET /health` / `GET /health/ready` — liveness/readiness, outside the
  versioned API prefix.
- Swagger UI at **`/api/docs`** (development only — disabled outright when
  `NODE_ENV=production`, since the strict Content-Security-Policy would
  break its inline bootstrap script anyway and there's no value in shipping
  a blank page). The same document is committed as `openapi.json` at the
  repo root, regenerated with `npm run openapi` (see the README's scripts table).
- Every route lives under `/api/v1`, except `/files/:publicId[/:variant]`,
  which is deliberately outside the versioned prefix.

## Roles and the permission matrix

Three staff roles (`users.role`): `admin`, `editor`, `support`. (The fourth,
`reviewer`, went with the scholarship feature: migration 021 refuses to run
while any account still holds it, then removes it from the column.)
There is no self-registration — the only way to create a staff account is
`POST admin/auth/invite` (admin-only), which emails an accept-invite link;
the very first admin comes from `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`
instead, created automatically on first boot.

The matrix lives in one place, `src/auth/role-matrix.ts` (B17). Every
role-gated admin route is tagged `@Area('<area>')`, which applies exactly
that area's roles. `GET admin/roles` (any signed-in staff member) returns the
same constants as `{roles, matrix}`. `npm run check:admin-roles` (CI, and
Jest via `test/content-security.spec.ts`) fails on any admin route with no
area, or whose roles differ from its area's.

| Area | admin | editor | support | Covers |
|---|:---:|:---:|:---:|---|
| `content` | ✅ | ✅ | | pages/sections, news + categories, work areas, board, stats, about items, partners, documents + categories (the governance sections), licences, media, redirects |
| `redirects.delete` | ✅ | | | deleting a redirect |
| `inbox` | ✅ | | ✅ | contact messages, testimonials + themes, newsletter subscribers |
| `inbox.delete` | ✅ | | | deleting a contact message |
| `users` | ✅ | | | staff accounts, invitations |
| `settings` | ✅ | | | site settings, mail settings/templates/logs, cache |
| `audit` | ✅ | | | the audit log |

Open to any signed-in staff member, with no area: `admin/me`,
`admin/auth/*` (own sessions, own password), `admin/overview`,
`admin/preview-token`, `admin/roles`. `GET admin/overview` adapts to the
caller's role, using the same role matrix as the routes behind each block:
message figures for the `inbox` area (admin, support — A5), the audit feed
for admins only (C20); content alerts for everyone.

### Staff accounts: status and lockout

- `users.status` is `active`, `disabled` or `invited`. Only an admin changes
  it (`PATCH admin/users/:id {status}`), except that accepting an invitation
  turns `invited` into `active`. Only an `active` account can sign in or hold
  a session. Disabling ends its sessions and deletes its outstanding
  invite/reset links. Forgot-password, reset and accept-invite never act on
  a `disabled` account, so a disabled user can't re-enable themselves.
- Ten wrong passwords lock the account for 15 minutes, then 30, then 60 on
  each further lock, never longer than 1 hour (A3). The backoff resets after a
  successful sign-in or 24 h after the last lock ended, and the count of
  wrong passwords resets 24 h after the last one (`users.last_failed_login_at`,
  migration 016). The lock doesn't end existing sessions. An admin clears it with
  `PATCH admin/users/:id {unlock: true}`; a completed password reset clears it too.
- Login only ever writes targeted `UPDATE`s, so it can't overwrite a
  concurrent password reset or disable.
- Every refusal (unknown email, disabled, invited, locked, wrong password)
  runs one Argon2 verify at the same cost, against a dummy hash built at boot
  with the real parameters (`src/auth/argon2-options.ts`), so response time
  doesn't reveal which emails are staff accounts (A2).
- The lockout counters are single `UPDATE`s whose `SET` runs left to right.
  Every connection (`src/database/utc.ts`, `scripts/lib/db-connection.mjs`)
  takes MariaDB's `SIMULTANEOUS_ASSIGNMENT` out of `sql_mode`, and boot
  fails if it is still set (A3).

## The staff cookie session

Staff are authenticated with a server-side session: cookie `sf_sid`
(configurable), backed by the `sessions` table, joined to `users`. Every
`/admin/*` route and the handful of session-authenticated non-admin routes
use it; `GET admin/me` returns the session's `csrfToken`. A random token is
set as the cookie and only its SHA-256 is stored; the CSRF token is an HMAC
derived from that hash. The cookie is `HttpOnly`, `SameSite=Strict` and,
outside development/test, `Secure` (`src/auth/cookie-options.ts`, C32).
Staging must therefore run over HTTPS, like production.

(Until migration 021 there was a second, separate session system for
scholarship applicants — the `sf_app_sid` cookie, `applicant_sessions` and
OTP sign-in. It was removed with the student portal.)

A staff member's session list (`GET admin/auth/sessions`) shows only
sessions that could still be used: not revoked, not expired, and not idle
past `SESSION_IDLE_HOURS` (C33).

## Governance and licences (022)

- `doc_categories.section_group` (`governance` | `other`) splits the
  documents register: `GET documents/sections` lists the published
  `governance` categories in `sort_order` with their published-document
  counts; `GET documents/sections/:slug` serves any published category.
  `GET documents` still lists every published category.
- `licences` is its own table. At most one row is primary; the primary
  *published* licence's number and issuer are written through to
  `site_settings.licence_no` / `licence_issuer_ar` / `licence_issuer_en`
  (GET /site, GET /home) by every admin/licences write, inside a transaction
  that locks the site_settings row. A published licence makes its file
  public on `/files`, and an asset a licence references can't be deleted.

## Time zone

Every database connection runs in UTC: the app (`src/database/utc.ts`), the
CLI data source, `scripts/migrate.mjs` and `db-reset.mjs` all set
`timezone: 'Z'` on mysql2 and `SET time_zone = '+00:00'` on each
connection, and the app refuses to boot if `NOW()` isn't UTC. This holds
whatever the process's `TZ` or the server's `@@global.time_zone` is. The
test suite runs the app with `TZ=Asia/Riyadh` (and CI runs MySQL at UTC+3)
to keep it that way (`test/utc.spec.ts`).
