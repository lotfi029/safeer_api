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

Four staff roles (`users.role`): `admin`, `reviewer`, `editor`, `support`.
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

| Area | admin | reviewer | editor | support | Covers |
|---|:---:|:---:|:---:|:---:|---|
| `applications` | ✅ | ✅ | | | applications, their documents/notes, interview slots, CSV export |
| `applications.delete` | ✅ | | | | `DELETE admin/applications/:id` (anonymise) |
| `content` | ✅ | | ✅ | | pages/sections, news + categories, work areas, board, stats, about items, partners, documents + categories, media, redirects |
| `redirects.delete` | ✅ | | | | deleting a redirect |
| `inbox` | ✅ | | | ✅ | contact messages, testimonials + themes, newsletter subscribers |
| `inbox.delete` | ✅ | | | | deleting a contact message |
| `users` | ✅ | | | | staff accounts, invitations |
| `settings` | ✅ | | | | site settings, mail and SMS settings/templates/logs, cache |
| `audit` | ✅ | | | | the audit log |

Open to any signed-in staff member, with no area: `admin/me`,
`admin/auth/*` (own sessions, own password), `admin/overview`,
`admin/preview-token`, `admin/roles`. `GET admin/overview` adapts to the
caller's role: application figures only for admin and reviewer, message
figures for everyone but reviewers, the audit feed for admins only (C20).

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

### Applicant OTP sign-in

- `POST portal/auth/request-otp` answers `{ok, channelHint}` at once (A4).
  Only the per-identifier limiter (429) runs first. The lookup, the
  `applicant_otps` row and the send run afterwards on `BackgroundWork`
  (`src/common/background/`): lookups on one queue, then each
  application's codes on their own queue, so codes are issued and delivered
  in request order and the last one delivered is the live one. The row is
  committed before the send (B1).
- On SIGTERM/SIGINT the app waits up to 10 s for that work before exiting
  (`app.enableShutdownHooks()`, `beforeApplicationShutdown`).
- Only a wrong code checked against a live code counts (A1). Ten inside a
  rolling hour lock OTP sign-in for 1 h; 30 in a UTC day lock it until the
  next day. While locked, verify answers `OTP_INVALID` and request-otp sends
  nothing, with the same responses as ever.

## Two cookie-session systems

Staff and applicants are authenticated with two entirely separate,
non-interchangeable session systems — a staff cookie is never accepted on a
portal route, and an applicant cookie is never accepted on a staff route
(`SessionGuard` resolves each against its own table):

- **Staff** — cookie `sf_sid` (configurable), backed by the `sessions`
  table, joined to `users`. Every `/admin/*` route and the handful of
  session-authenticated non-admin routes (`GET /me`, `/auth/*`) use this.
- **Applicant** — cookie `sf_app_sid` (configurable), backed by the
  `applicant_sessions` table, joined to `applications`. Minted by
  `POST applications` (starting a new application) or
  `POST portal/auth/verify-otp` (an existing applicant signing back in).
  Every `portal/*` route carrying the `@ApplicantRoute()` decorator uses
  this instead. `GET portal/me` returns the session's `csrfToken`, like
  `GET admin/me` does for staff (B16).

Both use the same underlying mechanics (a random token, only its SHA-256
ever stored, an HMAC CSRF token derived from that hash) — just against
different cookies, tables, and lifetimes. Both cookies are `HttpOnly`,
`SameSite=Strict` and, outside development/test, `Secure`
(`src/auth/cookie-options.ts`, C32). Staging must therefore run over HTTPS,
like production.

A staff member's session list (`GET admin/auth/sessions`) shows only
sessions that could still be used: not revoked, not expired, and not idle
past `SESSION_IDLE_HOURS` (C33).

## Time zone

Every database connection runs in UTC: the app (`src/database/utc.ts`), the
CLI data source, `scripts/migrate.mjs` and `db-reset.mjs` all set
`timezone: 'Z'` on mysql2 and `SET time_zone = '+00:00'` on each
connection, and the app refuses to boot if `NOW()` isn't UTC. This holds
whatever the process's `TZ` or the server's `@@global.time_zone` is. The
test suite runs the app with `TZ=Asia/Riyadh` (and CI runs MySQL at UTC+3)
to keep it that way (`test/utc.spec.ts`).
