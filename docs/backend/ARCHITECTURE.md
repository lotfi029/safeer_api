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

## Roles and permissions

Staff permissions are **`<module>.<action>` keys** held by **roles** stored
in the database (PERM-1–4, v1.1.0; migration 024). A user has exactly one
role (`users.role_id`) and no per-user overrides. There is no
self-registration — the only way to create a staff account is
`POST admin/auth/invite` (`users.manage`), which emails an accept-invite
link; the very first admin comes from `BOOTSTRAP_ADMIN_EMAIL`/
`BOOTSTRAP_ADMIN_PASSWORD` instead, created automatically on first boot.

**The catalog** is one file, `src/auth/permissions.ts`, served as-is by
`GET admin/permissions` (any signed-in staff member). Actions: `view` (list
and read), `manage` (create, edit, publish, reorder, upload), `delete`.
`delete` implies `manage`, which implies `view`, where the module has them;
every save closes the set that way. Each module lists only the actions its
routes have:

| Group | Module | Actions | Covers |
|---|---|---|---|
| Content | `pages` | view, manage, delete | pages and their sections |
| | `news` | view, manage, delete | posts, news categories, preview tokens |
| | `workAreas` | view, manage, delete | work areas and their items |
| | `board` · `orgChart` · `partners` · `licences` · `stats` · `aboutItems` · `media` · `redirects` | view, manage, delete | one collection each |
| | `documents` | view, manage, delete | documents and their categories |
| Inbox | `messages` | view, manage, delete | contact messages (reply, convert) |
| | `testimonials` | view, manage, delete | testimonials and their themes |
| | `newsletter` | view, delete | subscribers (list, CSV export, delete) |
| System | `users` | view, manage, delete | staff accounts, invitations, other users' sessions |
| | `roles` | view, manage, delete | roles |
| | `settings` | view, manage, delete | site settings, cache (purge is `settings.delete`) |
| | `mail` | view, manage | mail settings, templates, log, test send |
| | `audit` | view | the audit log |

**Enforcement.** Every admin handler carries `@Permission(key, ...extra)`
(all keys required); `PermissionsGuard` (global) checks them against
`req.user.permissions`, which `SessionGuard` loads in the same lookup as the
session on every non-public request — so a role edit applies on the user's
next request. The CRUD kernel takes one `module` option and applies view /
manage / delete per generated route. `npm run check:permissions` (CI, and
Jest via `test/content-security.spec.ts`) fails on any admin route with no
catalog permission, or whose first permission's action doesn't match its
HTTP method (GET → view, POST/PATCH/PUT → manage, DELETE → delete).

Open to any signed-in staff member, with no permission: `admin/me` (adds
`role` and `permissions`), `admin/auth/*` (own sessions, own password —
the invite inside it needs `users.manage`), `admin/overview`,
`admin/permissions`. `GET admin/overview` adapts to the caller: message
figures with `messages.view` (A5), the audit feed with `audit.view` (C20),
content alerts for everyone.

**System roles** (seeded by 024 with exactly what the old matrix gave,
route by route):

| Role | Permissions | Editable | Deletable |
|---|---|:---:|:---:|
| `admin` (مدير عام) | `*` | no | no |
| `editor` (محرر محتوى) | every content module, view/manage/delete — except `redirects.delete` | yes | no |
| `support` (دعم ومراسلات) | `messages` view/manage; `testimonials` view/manage/delete; `newsletter` view/delete | yes | no |

Custom roles get full CRUD (`admin/roles`, `roles.*`). Keys match
`^[a-z][a-z0-9-]{2,63}$`; `admin`, `editor`, `support`, `owner`, `root` and
`system` are reserved.

**Safety rules** (`RolesService`, `UsersService`, `AuthService`):

1. A caller grants only permissions they hold, and can't edit or delete a
   role that holds more than they do (no escalation).
2. Nobody edits or deletes their own role, or changes their own.
3. Assigning a role (invite, `PATCH admin/users/:id {roleId}`) needs every
   permission it holds — `GET admin/users/assignable-roles` lists exactly
   those. Managing a user, or ending their session, needs a role that covers
   theirs.
4. The last usable (active) holder of the `admin` role can't be demoted,
   disabled or deleted (`LAST_ADMIN`).
5. A role still assigned can't be deleted (`ROLE_IN_USE`, with `userCount`).
6. Role writes and user role changes are audited with the permission lists
   before and after.

The `admin` role can't be edited or deleted, and no system role can be
deleted (`ROLE_IMMUTABLE`, always 409).

`users.role` (the pre-024 enum) is still written — the system role's key,
or NULL for a custom role — only so the previous image can run if a release
is rolled back. Nothing reads it for access; a later migration (025) drops
it.

### Staff accounts: status and lockout

- `users.status` is `active`, `disabled` or `invited`. Only a `users.manage`
  holder changes it (`PATCH admin/users/:id {status}`), except that accepting an invitation
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

## Organisational structure (023)

- `org_positions` is a tree (`parent_id` → itself, `ON DELETE RESTRICT`);
  `board_members.org_position_id` says which position a member holds.
  `GET org-chart` builds the published forest with each position's
  published holders; `LocaleInterceptor` collapses names inside it.
- Tree writes (`admin/org-positions`) lock every position row first and run
  `org-chart/tree-guard.ts` — no self-parent, missing parent or cycle, at
  most 5 levels counted both ways — so two concurrent moves can't form a
  cycle. Delete returns 409 with what still references the position.

## Time zone

Every database connection runs in UTC: the app (`src/database/utc.ts`), the
CLI data source, `scripts/migrate.mjs` and `db-reset.mjs` all set
`timezone: 'Z'` on mysql2 and `SET time_zone = '+00:00'` on each
connection, and the app refuses to boot if `NOW()` isn't UTC. This holds
whatever the process's `TZ` or the server's `@@global.time_zone` is. The
test suite runs the app with `TZ=Asia/Riyadh` (and CI runs MySQL at UTC+3)
to keep it that way (`test/utc.spec.ts`).
