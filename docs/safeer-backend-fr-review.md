# Safeer Backend — Functional Requirements Review

**Repo:** `repos/safeer_api` (local HEAD `e934d8f` = `origin/main`)
**Reviewed against:** `docs/safeer-design-spec.md` + `docs/safeer-implementation-prompt.md`
**Date:** 2026-09-26
**Checks run:** `npm ci` ✅ · `npm run build` ✅ (no TS errors) · `npm run lint` ✅ · smoke suite not run (needs MySQL)

## Verdict

Functional coverage is high: every screen in the spec (public site, 3 portal screens, 14 admin screens) has matching API routes, and the 4-role permission matrix is enforced. It is **not ready to deliver yet**. One blocker stops students from logging in, there are 5 functional bugs, and the stack departs from the spec in ways you need to accept or fix.

---

## 1. FR coverage matrix

| # | Requirement (source) | Status | Evidence / note |
|---|---|:--:|---|
| **Public site** |||
| P1 | Home aggregate: hero → about → impact → areas → student care → news → testimonials/partners → CTA | ✅ | `GET /home`, seeded sections in that order |
| P2 | About: vision/mission/5 goals + meeting-minutes entry | ✅ | `about_items`, doc category `meeting-minutes` |
| P3 | Board: 5 members + executive, template cards removed | ✅ | `GET /board`, `grp: board/executive` |
| P3b | Board member `bio_ar/en` (data model) | ❌ | Column missing on `board_members` |
| P4 | Work areas: 4 areas + items + beneficiary-feedback themes | ✅ | `/work-areas`, `testimonial_themes` |
| P5 | Scholarships: 4 care pillars + 5 steps + requirements | ✅ | `about_items` kinds `scholarship_step`, etc. |
| P6 | News: Arabic categories, featured, search, pagination | ✅ | `/news?q&category&page`, `/news/featured` |
| P7 | Article page + related news | ✅ | `/news/:slug` returns `related` |
| P8 | Testimonials: featured + 5 themes + grid | ✅ | `/testimonials` |
| P9 | Partners: logo grid + categories | ✅ | `category` enum, `url`, logo asset |
| P10 | Licences & policies: title, size, date, download | ✅ | `/documents` (+ download count) |
| P11 | Contact: subject field, honeypot, rate limit | ✅ | `POST /contact`, subject enum |
| P12 | Newsletter | ✅ | `POST /newsletter` + admin CSV export |
| P13 | ar/en columns + Arabic fallback when en is empty | ✅ | `LocaleInterceptor.collapseBilingual` |
| P14 | SEO data (titles/descriptions per page + global) | ✅ | `pages.meta_*`, `site_settings.seo_*` |
| P14b | Sitemap / hreflang data source | ⚠️ | No slug-list endpoint; frontend must page through `/news` |
| **Apply flow** |||
| A1 | 3-step form with the 13 fields | ✅ | `application-fields.schema.ts` (`about` → `scholarshipNote`, `degree` → `degreeLevel` + `major`) |
| A2 | Autosave | ✅ | `PATCH /portal/application` on a draft |
| A3 | Document upload | ✅ | `POST /portal/documents` (5 MB, magic-byte check) |
| A4 | Declaration/consent | ✅ | `consent: z.literal(true)` on submit |
| A5 | Ref `SA-YYYY-NNNNN` | ✅ | Transactional yearly counter |
| **Student portal** |||
| S1 | OTP login via **phone or email**, 10 min, no password | ⚠️ | 10 min ✅, 5-attempt cap ✅, but login is by reference/email only, never phone. See B1/B2 |
| S2 | Status: ref, badge, 5-stage timeline, action alert, summary, update log | ✅ | `GET /portal/me`, `portal-timeline.ts`, notifications |
| S3 | My documents: per-doc status + rejection reason + completeness bar | ✅ | `GET /portal/documents` → `completeness` |
| S4 | Statuses `NEW→UNDER_REVIEW→DOCS_MISSING→INTERVIEW→ACCEPTED/REJECTED` | ✅ | Plus `draft`; transition map enforced |
| S5 | Interview booking | ✅ (extra) | Not in spec; bonus feature |
| **Admin** |||
| D1 | Overview: 4 KPIs, chart, content-leftover alert, latest applications | ✅ | `GET /admin/overview` (role-aware) |
| D2 | Applications: status filter, bulk select, assign reviewer, CSV, pagination | ✅ | `/admin/applications`, `/bulk`, `/export.csv` |
| D3 | Review: accept/reject each doc (with reason), internal notes, action log | ✅ | Notes and `visibleToApplicant=false` events never reach the portal |
| D4 | Messages: inbox, reply, archive, convert to testimonial | ✅ | `/admin/messages/*` |
| D5 | Pages table: URL, **section count**, last edit, status | ⚠️ | Section count not returned by `GET /admin/pages` |
| D6 | Page editor: reorder/hide sections, field editor, preview | ✅ | `page-sections` reorder/publish + `preview-token` |
| D7 | News admin + bulk delete of template content + categories | ✅ | `DELETE /admin/news/legacy` |
| D8 | Work areas: reorder items, toggle visibility, change icon | ⚠️ | Areas ✅; **items** have no visibility toggle |
| D9 | Board ordering + executive section | ✅ | |
| D10 | Testimonials with approval status + themes | ✅ | `pending/published/hidden`, featured |
| D11 | Partners + categories | ✅ | |
| D12 | Documents: upload + sections | ✅ | `doc-categories`, `documents`, media |
| D13 | Users: 4 roles + explicit matrix | ✅ | Invite-only, `GET /admin/roles` |
| D14 | Settings: org info, languages, SEO, social links | ✅ | `en_enabled`, `seo_*`, FB/IG/X only |
| R1 | Student data only for admin + reviewer | ⚠️ | Holds for application routes; see B6 (audit feed) |

---

## 2. Bugs and gaps to fix (priority order)

### Blocker

**B1. Students cannot receive their OTP in production.** `requestOtp` always picks SMS, because `phone` is required at step 1. The SMS service only has a `log` driver (the default) and an untested generic `http` driver. There is no email fallback. With the default config the code is written to `sms_log` and never sent.
→ Let the student choose the channel (`sms | email`), fall back to email when the SMS driver is `log` or fails, and connect a real Saudi SMS provider (Unifonic, Taqnyat, or Msegat) before launch.
`src/portal/portal-otp.service.ts:76`

### High

**B2. Email login picks an arbitrary application.** `applications.email` is not unique, and `POST /applications` has no duplicate check. `findApplication()` ends in `getOne()`, so a student with 2 drafts gets signed in to whichever row comes back first. The same function also cannot match a phone number, which the spec asks for.
→ Block a second active application per email/phone, or return a chooser. Add phone as an identifier.
`src/portal/portal-otp.service.ts:170`, `src/applications/applications.service.ts`

**B3. A student can replace documents at any status.** `upload()` never checks `application.status`. After an `accepted` decision, a student can still supersede an accepted ID copy, and the replacement comes back as `under_review`. That rewrites the reviewed record.
→ Allow uploads only in `draft` and `docs_missing`, and in `docs_missing` only for the rejected or requested types. Also clean up the stored file if the DB transaction fails. Today the file is written before the transaction, so a failure leaves an orphan.
`src/portal/portal-documents.service.ts:53`

**B4. Redirects are editable by every staff role.** `RedirectsController` has no `@Roles`. The guard is opt-in, so a reviewer or support user can redirect `/apply` to any URL.
→ Add `@Roles('admin', 'editor')`. `src/redirects/redirects.controller.ts`

**B5. Media upload and listing are open to every staff role.** `admin/media` has no class-level `@Roles`, and only DELETE is admin-only. The matrix gives media to admin and editor only.
→ Add `@Roles('admin', 'editor')` at class level. `src/media/media.controller.ts:21`

### Medium

**B6. Every role sees the last audit entries.** The overview's `recentAuditLog` is returned to all roles, and it includes application references, status changes, and reviewer/user actions. `/admin/audit` itself is admin-only.
→ Filter the feed by role, or return it to admin only. `src/admin-applications/admin-overview.service.ts:154`

**B7. Assigning a reviewer does not check the user's role or lock state.** An application can be assigned to an editor, a support user, or a locked account, and that person then cannot open it.
→ Require `role in (admin, reviewer)` and `!isLocked`. `src/admin-applications/admin-applications.service.ts:347`

**B8. Content deletion is admin-only.** `CrudController` defaults `deleteRoles` to `['admin']`, so editors cannot delete news, partners, board members, or documents. Support cannot delete testimonials. The spec matrix gives editors full content management.
→ Pass `deleteRoles: ['admin','editor']` (or `'support'` for testimonials), or confirm this restriction is intended.

**B9. Seed data problems.**
- The testimonial seeded in `002_seed.sql` (production) is `published` and `featured`, but its text still contains the placeholder «[يُستكمل النص الكامل…]». It will show on the live home page. Set it to `pending`.
- Section button URLs are prototype hash routes (`#/apply`, `#/about`). The Next.js frontend uses `/{locale}/apply`, so these need updating.

### Low

- **B10.** `GET /admin/pages` does not return a section count (D5). Add `loadRelationCountAndMap`.
- **B11.** Work-area items have no `is_published` toggle (D8).
- **B12.** `board_members` has no bio column (P3b).
- **B13.** News search does not escape `%` and `_` in `LIKE`. `escapeLikeValue()` already exists in `list-params.ts`. `src/news/news.controller.ts:73`
- **B14.** `submit()` has no row lock, so a double-click can send two submissions. Low impact, because the second call is rejected once `status ≠ draft`.
- **B15.** There is no sitemap or slug-index endpoint for the frontend's `sitemap.xml` and `hreflang` (P14b).

---

## 3. Departures from the implementation prompt (need your decision)

| Spec says | Repo does | Recommendation |
|---|---|---|
| PostgreSQL + Prisma | MySQL/MariaDB + TypeORM, raw SQL migrations | Accept if Hostinger shared Node hosting is the target (it only offers MariaDB). Record the decision. |
| JWT + refresh | DB-backed cookie sessions + CSRF | Accept. Sessions can be revoked, which is safer than JWT for an admin panel. |
| S3-compatible storage + short-lived signed URLs | Local disk `STORAGE_ROOT`, streamed through auth-guarded routes | Private documents are still protected, so the security goal is met. But there is no backup of uploads and no storage abstraction. Add at least a backup of `STORAGE_ROOT`. |
| Jest + supertest tests for applications and permissions | **No test suite.** Only `scripts/smoke.mjs` (end-to-end against a live server) | ❌ This is an explicit acceptance criterion. Add Jest + supertest for the applications and roles paths. |
| `docs/` never pushed; only a short README | Pushed: `docs/prototype/safeer-prototype.html`, `DEPLOYMENT-HOSTINGER.md`, `KNOWN-ISSUES.md`. `.gitignore` has no `docs/` entry | ❌ Violates the project rule. Move these files to `D:\Freelance\Safeer\docs\`, `git rm --cached` them, and add `docs/` to `.gitignore`. Note that `npm run seed` reads the prototype from `docs/prototype/`, so update that path too. |
| Repos at `Safeer\frontend` and `Safeer\backend` | `Safeer\repos\safeer_api`; frontend repo not created yet | Cosmetic. Confirm the layout you want. |

---

## 4. What's done well

- Transactional, race-safe reference numbers (`SELECT … FOR UPDATE` on a yearly counter).
- Staff and applicant sessions are fully separate. A cookie from one is rejected by the other.
- OTP flow does not reveal whether an application exists, caps attempts at 5 under a row lock, and rate-limits both per IP and per identifier.
- Private documents: magic-byte MIME check, 5 MB cap, ownership check that returns 404 for other people's files, no public path.
- Internal notes and staff-only events never reach the portal.
- Transition map is enforced, including a separate rule for request-documents.
- RFC 7807 errors, append-only audit log, hashed IPs, and `openapi.json` checked in CI.
- Seed data is taken from the real site, with `[…]` placeholders where facts are missing. The only real number is "2 years of experience".
