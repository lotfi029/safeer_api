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

| Area | admin | reviewer | editor | support |
|---|:---:|:---:|:---:|:---:|
| Applications, application docs/notes, interview slots, applications CSV export | ✅ | ✅ | | |
| Pages/sections, news, categories, work areas, board, stats, about-items, partners, doc categories, documents, media | ✅ | | ✅ | |
| Messages, testimonials, testimonial themes, newsletter subscribers | ✅ | | | ✅ |
| Users, settings, mail, audit, cache | ✅ | | | |

`GET admin/overview` adapts to the caller's role: applications figures are
hidden from editors, message figures from reviewers. `GET admin/roles`, which
will return this same matrix for the admin users screen, does not exist yet
(B17 in `docs/safeer-backend-fix-prompt.md`, Phase 5).

### Staff accounts: status and lockout

- `users.status` is `active`, `disabled` or `invited`. Only an admin changes
  it (`PATCH admin/users/:id {status}`), except that accepting an invitation
  turns `invited` into `active`. Only an `active` account can sign in or hold
  a session. Disabling ends its sessions and deletes its outstanding
  invite/reset links. Forgot-password, reset and accept-invite never act on
  a `disabled` account, so a disabled user can't re-enable themselves.
- Ten wrong passwords lock the account for 15 minutes, then 30, 60 … (capped
  at about 16 h) on each further lock, until a successful sign-in. The lock
  doesn't end existing sessions. An admin clears it with
  `PATCH admin/users/:id {unlock: true}`; a completed password reset clears it too.
- Login only ever writes targeted `UPDATE`s, so it can't overwrite a
  concurrent password reset or disable.

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
different cookies, tables, and lifetimes.

## Time zone

Every database connection runs in UTC: the app (`src/database/utc.ts`), the
CLI data source, `scripts/migrate.mjs` and `db-reset.mjs` all set
`timezone: 'Z'` on mysql2 and `SET time_zone = '+00:00'` on each
connection, and the app refuses to boot if `NOW()` isn't UTC. This holds
whatever the process's `TZ` or the server's `@@global.time_zone` is. The
test suite runs the app with `TZ=Asia/Riyadh` (and CI runs MySQL at UTC+3)
to keep it that way (`test/utc.spec.ts`).
