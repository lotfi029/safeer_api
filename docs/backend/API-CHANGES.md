# API contract changes (fix plan, phases 1–7)

What the frontend has to know about the changes made by
`docs/safeer-backend-fix-prompt.md`. `openapi.json` is the full contract;
this file lists what *changed* and why, grouped by area. Item numbers
(B…/C…) refer to `docs/safeer-backend-code-review.md` and
`docs/safeer-backend-fr-review.md`.

## Links in mail and SMS (C2)

Every mailed or texted link now points at the **frontend**
(`FRONTEND_BASE_URL`), locale-prefixed. The frontend must serve these routes:

| Link | Route |
|---|---|
| Staff invitation | `/{locale}/admin/accept/{token}` → `POST admin/auth/accept-invite` |
| Password reset | `/{locale}/admin/reset/{token}` → `POST admin/auth/reset-password` |
| Applicant portal | `/{locale}/portal/login` |
| New contact message (staff) | `/{locale}/admin/messages/{id}` |
| Newsletter confirmation (C27) | `/{locale}/newsletter/confirm?email=…&token=…` → `POST newsletter/confirm` |
| Newsletter unsubscribe (C27) | `/{locale}/newsletter/unsubscribe?email=…&token=…` → `POST newsletter/unsubscribe` |

Staff links use `ar` (users have no locale). Applicant links use the
application's locale.

## Applicant portal

- **OTP (C1, C22, A1).** The mail subject no longer carries the code. A new
  code invalidates older ones. Ten wrong codes inside an hour lock OTP
  sign-in for **1 hour**; 30 in a UTC day lock it until the next UTC day.
  Only a wrong code for a live code counts (a verify with no code issued, or
  after a code's 5 attempts are spent, doesn't). While locked, verify always
  answers `OTP_INVALID`, and request-otp sends nothing but still answers the
  same. If the frontend explains a lockout, say "try again in an hour", not
  "tomorrow".
- **request-otp answers before sending (A4).** `POST portal/auth/request-otp`
  still returns `{ok: true, channelHint}` (or 429), but now at once,
  before the identifier is even looked up. The code arrives a moment later:
  usually within a second, up to ~5 s when an SMS times out and falls back to
  email. The response never means a message went out. For e2e runs against
  a real API: `GET __dev/otp/:applicationId` (development/test only) waits
  for sends still in flight before answering, and `POST __dev/settle` waits
  for all background work.
- **Editing (C15).** `PATCH portal/application` works only while `draft`;
  otherwise it returns 409 `APPLICATION_LOCKED`. While `docs_missing`, use
  `PATCH portal/application/corrections` instead. It accepts `firstName`,
  `middleName`, `lastName`, `birthDate`, `nationality`, `idNumber`,
  `university`, `major` and `degreeLevel` (never email or phone), and
  records an `APPLICANT_CORRECTED` event.
- **Names (C16).** First, middle and last names (and the contact form's
  `name`) accept Arabic and Latin letters, spaces, `'` and `-` only.
  Anything else returns 400.
- **Documents (B19, C18).**
  - Responses are `{id, docType, originalName, mime, sizeBytes, status, rejectionReason, createdAt}`.
  - Uploads are limited to 20/hour, and each application to 30 uploads or
    50 MB in total. Past that, the API returns 409 `QUOTA_EXCEEDED`.
  - Arabic filenames round-trip (C19).
- **Interview (C17).**
  - `GET portal/interview-slots` lists future open slots only, and is empty
    once the applicant has booked.
  - Booking again returns 409 `SLOT_ALREADY_BOOKED`, and so does taking a
    slot someone else holds. A past slot returns 409
    `INTERVIEW_NOT_AVAILABLE`.
  - New `DELETE portal/interview` cancels the booking. It returns
    `{cancelled: true}`, or 404 if nothing is booked.
  - `GET portal/me` gains `interview: {id, startsAt, endsAt, location} | null`.
  - Booking, cancelling and a staff change to a booked slot each send a
    mail and SMS.
  - A9: `POST portal/interview` and `DELETE portal/interview` are each
    limited to 5 an hour per IP (429 `RATE_LIMITED` past that).

## Staff

- **Accounts (C3, C12).**
  - `PublicUser` gains `status` (`active` | `disabled` | `invited`) and
    `lockedUntil`. `isLocked` is now derived (a brute-force lock is in
    effect).
  - `PATCH admin/users/:id` takes `{status}` and `{unlock: true}`.
  - A disabled account cannot log in, reset or accept an invite.
  - Ten failed logins lock the account for 15, then 30, then 60 min, never
    longer than 1 h (A3). The backoff resets 24 h after the last lock, and
    the failure count 24 h after the last wrong password. `lockedUntil` is
    therefore at most an hour ahead.
  - Every refused login takes the same time, whether or not the email exists (A2).
- **Overview (C20).**
  - `statCards.newApplications|underReview|acceptedThisMonth`, `series` and
    `latestApplications` are present only for admin and reviewer.
  - A5: `statCards.unreadMessages` and `badges.unreadMessages` are present
    only for admin and support (the inbox roles). Editors no longer get them.
  - `recentAuditLog` is admin-only (an empty array for other roles). Each
    entry is `{id, action, entityType, entityId, entityLabel, actorId, actorName, createdAt}`,
    with no diff and no IP hash. The full log stays in `GET admin/audit`.
- **Applications.**
  - Status changes are transactional. Of two conflicting changes, exactly
    one succeeds; the other returns 409 (C6).
  - Reviewing a superseded document, or one on a draft/accepted/rejected
    application, returns 409 `DOCUMENT_NOT_REVIEWABLE` (C34).
  - New `DELETE admin/applications/:id` (admin only) anonymises an
    application (C27). It returns `{anonymized: true, reference}`. PII,
    documents and their files, notes, events and mail/SMS logs are removed;
    the reference and status stay.
  - The detail's `personal.idNumber` is decrypted. The CSV export's ID
    column is `ID (last 4)`, masked as `••••1234` (C28).
  - Document objects in the detail follow B19, plus `reviewedBy`,
    `reviewedAt` and `supersededAt`.
- **Interview slots (C17).** `endsAt` must be after `startsAt` on create, and
  on a partial PATCH against the stored values. Otherwise the API returns
  400.
- **News (C13, C14).**
  - Creating or updating a post as published without a cover succeeds, and
    the response carries `warnings: ["COVER_MISSING"]`. Every create/update
    response carries `warnings` (usually `[]`).
  - Publishing without a `publishedOn` sets it to today (UTC).
  - A `slug` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be at most 180
    characters, and not be a reserved word (`featured`, `new`, `edit`,
    `preview`, `admin`, `api`, `sitemap`, `search`, `feed`, `rss`).
    Otherwise the API returns 400.
  - Generated slugs follow the same rule (`post-<n>` for all-Arabic titles).
- **Pages (C14).** A page's `slug` is fixed after creation; sending it in a
  PATCH returns 400.
- **URLs (C10).** Button URLs, partner URLs and social links must be `https:`,
  `http:`, `mailto:` or `tel:` (buttons may also be a `/site/path`).
  Redirects must be site paths with `from ≠ to`, and chains return 409
  `REDIRECT_CHAIN`.
- **Newsletter admin (C27).** The subscriber list shows a `pending` status
  (not yet confirmed), and the CSV has a "Confirmed at" column.

- **Application documents (A11).**
  - Each document in `GET admin/applications/:id` (and the
    `PATCH …/documents/:docId` response) gains `downloadPath`: the file
    route relative to the API base
    (`admin/applications/{id}/documents/{docId}/file`), or `null` for a
    superseded document. Show a download link only when it is set.
  - `GET admin/applications/:id/documents/:docId/file` for a superseded
    document now answers 410 `DOCUMENT_SUPERSEDED` (its file was deleted
    when it was replaced), not a bare 404.

## Public site

- **Markdown (C26).** Page-section bodies (`GET pages/:slug`) and about-item
  bodies (`GET home` → `aboutItems.goals|carePillars`) are now **sanitized
  HTML**, rendered from the stored Markdown like news `bodyHtml`. Render them
  as HTML.
- **Newsletter (C27).** `POST newsletter` now sends a confirmation mail. The
  address counts as subscribed only after `POST newsletter/confirm {email, token}`.
  `POST newsletter/unsubscribe {email, token}` takes the signed token from
  a newsletter mail. A bad token returns 400.
- **Caching (C24, C25).**
  - `?preview` is ignored on routes other than news detail.
  - Public originals and PDFs are cached for 5 minutes (variants stay
    immutable).
  - A document is public only while its category is published.
- **Contact-page map (A12).** `GET /site` → `settings` gains
  `mapEmbedUrl: string | null`, `mapLat: number | null`, `mapLng: number | null`.
  `mapEmbedUrl` is meant as an iframe `src`; the API accepts only https
  Google Maps embeds (`https://www.google.com/maps/embed…`) or OpenStreetMap
  (`https://www.openstreetmap.org/…`). Allow those two origins in the
  frontend's `frame-src`. `GET/PUT admin/settings` take and return the same
  three fields (latitude −90…90, longitude −180…180; anything else is 400).

## Phase 5 additions

- **Roles (B17).** New `GET admin/roles` (any staff) returns `{roles, matrix}`,
  where `matrix` maps an area to the roles allowed in it (see
  `docs/backend/ARCHITECTURE.md`). Build the dashboard navigation from it.
- **Pages list (B10).** Each row in `GET admin/pages` carries `sectionsCount`.
- **About items (B18).** New public `GET about-items?kind=vision,mission,goal,care_pillar,scholarship_step,requirement`
  (all kinds if `kind` is omitted). It returns `{ [kind]: [{id, icon, title, body, sortOrder}] }`,
  with only published items, sorted, and `body` as sanitized HTML. An unknown
  kind returns 400.
  `GET pages/about` now has sections `intro`, `vision_mission`, `goals` and
  `governance`; `GET pages/scholarships` has `hero`, `pillars`, `steps`,
  `requirements` and `cta` (migration 014, prototype copy).
- **Portal notifications (C35).** `GET portal/notifications` items are
  `{id, type, data, createdAt}`, the same shape as `/portal/me`'s `recentEvents`.
- **CSV export (C36).** The response has `X-Truncated: true|false` (exposed
  through CORS). The export is capped at 5000 rows.
- **News detail (C39, C41).**
  - `readMinutes` now matches the body shown in the requested language.
  - A whitespace-only English field falls back to Arabic.
  - With a valid `?preview=` token, the response has `previewFileQuery`.
    Append it to that post's `/files/…` URLs so an unpublished cover loads
    without a session.
- **Markdown (C40).** `#` renders as `<h2>`, and GFM tables render as `<table>`
  (with `align` on cells). Style both.
- **Filters (C42).** `GET news?category=<unknown slug>` and
  `GET partners?category=<unknown>` return 400 instead of an empty list.
- **Forgot password (C33).** The response no longer waits for the mail, so
  it takes the same time whether or not the address exists. Changing a
  password is limited to 5 attempts per 15 minutes.
- **English text (C39).** Admin DTOs trim every `*En` field.

## VPS deploy (S1–S4, BF-2, BF-4, D1)

**The HTTP contract is unchanged.** No route, DTO or response shape moved;
`openapi.json` is identical. What changed for whoever runs the API:

- **`POST applications` under load (S1/BF-2).** Concurrent creates by
  different applicants no longer deadlock into a `500`. The answers are
  unchanged: `201` with a reference, or `409 APPLICATION_EXISTS`.
- **New env vars (D1, BF-4):**
  - `TRUST_PROXY`: Express trust-proxy hop count, `0`–`10`, default `1`.
    It was hardcoded to `1`.
  - `HOST`: the bind address. **Default `127.0.0.1`**, where the API used to
    bind every interface. A bare-host deploy with its proxy on another
    machine must now set `HOST` explicitly. The Docker image sets `0.0.0.0`.
  - An empty value (`KEY=`) means the default, so `TRUST_PROXY=` is `1`,
    not `0`.
- **Production database: MySQL 8.4** (S4), in a container on the VPS.
  `safeer-web`'s `API_INTERNAL_URL` is `http://safeer-api:3900` (the api service's alias; the plain name `api` collides with other projects on the shared edge network) on the private
  Compose network (`deploy/docker-compose.yml`).


## Governance and contact (branch `feat/governance-contact`)

The owner removed the scholarship feature (application form, applicant
portal, review, interviews, the `scholarships` page), SMS and the `reviewer`
role, kept the contact form with new subjects, and added governance sections
and licences. Each item below names its commit (A1–A8).

### Admin overview (A1)

`GET admin/overview` moved to its own module (`src/admin-overview/`). The
response is now exactly:

```json
{
  "statCards": { "unreadMessages": 3 },
  "contentAlerts": { "noPublishedPartners": false, "legacyPostsCount": 0, "pagesNeedingReviewCount": 0 },
  "badges": { "unreadMessages": 3 },
  "recentAuditLog": []
}
```

Removed fields: `statCards.newApplications`, `statCards.underReview`,
`statCards.acceptedThisMonth`, `badges.newApplications`, `series` (the
6-month received/accepted chart) and `latestApplications`. The role rules
are unchanged: `unreadMessages` only for admin and support, `recentAuditLog`
non-empty only for admin.

### Removed routes (A2, A3)

All of these now answer 404 (no route). The `sf_app_sid` applicant cookie is
never set or read again.

| Removed | Was |
|---|---|
| `POST applications` | start a scholarship application |
| `POST portal/auth/request-otp`, `POST portal/auth/verify-otp`, `POST portal/auth/logout` | applicant OTP sign-in |
| `GET portal/me`, `GET portal/notifications` | applicant portal |
| `PATCH portal/application`, `PATCH portal/application/corrections`, `POST portal/application/submit` | application form |
| `GET/POST portal/documents`, `GET portal/documents/{id}/file`, `DELETE portal/documents/{id}` | applicant documents |
| `GET portal/interview-slots`, `POST/DELETE portal/interview` | interview booking |
| `GET admin/applications`, `GET admin/applications/counts`, `GET admin/applications/assignees`, `GET admin/applications/export.csv`, `POST admin/applications/bulk` | application review list |
| `GET/PATCH/DELETE admin/applications/{id}`, `POST admin/applications/{id}/request-documents`, `PATCH admin/applications/{id}/documents/{docId}`, `GET admin/applications/{id}/documents/{docId}/file`, `POST admin/applications/{id}/notes` | one application |
| `GET/POST admin/interview-slots`, `GET/PATCH/DELETE admin/interview-slots/{id}` | interview slots |
| `GET/PUT admin/sms/settings`, `POST admin/sms/test`, `GET admin/sms/templates`, `GET/PUT admin/sms/templates/{key}`, `GET admin/sms/templates/{key}/variables`, `POST admin/sms/templates/{key}/preview`, `GET admin/sms/log` | SMS |
| `GET __dev/otp/{applicationId}` (development/test only, not in openapi.json) | OTP peek |

Also gone:

- **Error codes:** `APPLICATION_LOCKED`, `OTP_INVALID`, `DOCUMENTS_INCOMPLETE`,
  `SLOT_ALREADY_BOOKED`, `INTERVIEW_NOT_AVAILABLE`, `INVALID_STATUS_TRANSITION`,
  `APPLICATION_EXISTS`, `INVALID_ASSIGNEE`, `QUOTA_EXCEEDED`,
  `DOCUMENT_NOT_REVIEWABLE`, `DOCUMENT_SUPERSEDED`.
- **`GET meta/enums`:** `applicationStatus`, `degreeLevel` and `gender`. It
  now returns `{partnerCategory, contactSubject}` only.
- **`GET about-items`:** the kinds `scholarship_step` and `requirement` (now a
  400 like any unknown kind). `vision`, `mission`, `goal` and `care_pillar`
  remain; `GET /home`'s `aboutItems.carePillars` is unchanged.
- **The `scholarships` page** (`GET pages/scholarships` is 404) and its nav
  entry. Home-page buttons that pointed at `/apply`, `/portal/…` or
  `/scholarships` now point at `/contact` (their labels are content, edited in
  the admin).
- **Admin settings:** `notifyEmailOnStatusChange`, `notifySmsOnStatusChange`
  and `applicationRefPrefix` are gone from `GET/PUT admin/settings`; sending
  them is a 400 (the DTO is strict).
- **The `reviewer` role** (A3): `GET admin/roles` returns
  `roles: ["admin", "editor", "support"]` and no `applications` /
  `applications.delete` areas. `POST admin/auth/invite` and
  `PATCH admin/users/:id` answer 400 `VALIDATION_FAILED` for
  `role: "reviewer"`.
- **Mail templates:** `application_started`, `application_submitted`,
  `application_status_changed`, `application_resume`, `document_rejected`,
  `documents_requested`, `otp_code`, `interview_booked`,
  `interview_cancelled`, `interview_updated` (`GET admin/mail/templates` no
  longer lists them).

### Contact subjects (A5)

`POST contact`'s `subject` is one of `inquiry`, `partnership`, `support`,
`feedback`, `other` (there is no default; it is required). `scholarship` is
now a 400. Migration 021 turned every stored `scholarship` message into
`inquiry`, so the admin inbox (`GET admin/messages`) only ever shows the new
values. `GET meta/enums` → `contactSubject` (labels collapsed by locale, like
every public response):

| value | ar | en |
|---|---|---|
| `inquiry` | استفسار | Inquiry |
| `partnership` | شراكة | Partnership |
| `support` | دعم وتبرع | Support and donations |
| `feedback` | ملاحظات | Feedback |
| `other` | أخرى | Other |

The staff notification mail (`contact_notify`) carries the Arabic label.

### Governance sections (A6, migration 022)

Every public response collapses `xxxAr`/`xxxEn` pairs into `xxx` for the
request's locale (`?lang=` → `Accept-Language` → `ar`, English falling back
to Arabic). The shapes below show the collapsed form the frontend receives.

**`GET documents/sections`** — published categories in the `governance`
group, ordered by `sortOrder` then id, each with its count of published
documents (0 included). Cached under `documents`.

```json
[
  { "id": "2", "slug": "bylaws-policies", "name": "اللوائح والسياسات", "sectionGroup": "governance", "count": 1 },
  { "id": "5", "slug": "financial-reports", "name": "التقارير المالية", "sectionGroup": "governance", "count": 0 }
]
```

The seeded order: `bylaws-policies`, `financial-reports`, `general-assembly`,
`strategic-plan`, `operational-plan`, `annual-reports`, `project-reports`,
`committees`, `committee-decisions`. (`policies-regulations` was renamed
`bylaws-policies` and `meeting-minutes` `general-assembly`; their ids and
documents are unchanged. `licences` is now unpublished and in the `other`
group — its documents moved to the licences table.)

**`GET documents/sections/:slug`** — one published category of any group,
with its published documents (ordered by `sortOrder`, then id). An unknown or
unpublished slug is **404** `NOT_FOUND`.

```json
{
  "category": { "id": "5", "slug": "financial-reports", "name": "Financial reports", "sectionGroup": "governance" },
  "documents": [
    {
      "id": "12",
      "title": "Financial statements 2025",
      "meta": "Financial year 2025",
      "docDate": "2026-03-01",
      "asset": { "id": "40", "publicId": "…", "kind": "pdf", "mimeType": "application/pdf", "sizeBytes": 123456, "widthPx": null, "heightPx": null, "alt": null },
      "sortOrder": 0
    }
  ]
}
```

**`GET documents`** (unchanged route) — each `category` gains
`sectionGroup`, each document gains `meta` (from `metaAr`/`metaEn`, nullable).

**Admin:** `admin/doc-categories` create/update accept `sectionGroup`
(`"governance"` default | `"other"`); `admin/documents` create/update accept
`metaAr`, `metaEn` (string ≤ 190, trimmed, nullable). Both come back raw in
admin responses.

**Nav:** `GET /site` lists a new `governance` page (الحوكمة / Governance) in
the slot `documents` held: `home, about, board, work, news, testimonials,
partners, governance, contact`. `GET pages/governance` serves it;
`GET pages/documents` still works but is out of the nav.

### Licences (A7, migration 022)

**`GET licences`** — published licences, the primary first, then by
`sortOrder`, then id. A plain array (no paging). Cached under `licences`.

```json
[
  {
    "id": "3",
    "title": "ترخيص المركز الوطني لتنمية القطاع غير الربحي",
    "number": "1234",
    "issuer": "المركز الوطني لتنمية القطاع غير الربحي",
    "issuedOn": "2024-01-15",
    "expiresOn": "2027-01-14",
    "isPrimary": true,
    "asset": { "id": "41", "publicId": "…", "kind": "pdf", "mimeType": "application/pdf", "sizeBytes": 98765, "widthPx": null, "heightPx": null, "alt": null }
  }
]
```

`number`, `issuer`, `issuedOn`, `expiresOn` and `asset` may be null. The file
is fetched like every asset, `GET /files/{publicId}` — public once the
licence is published.

**`GET /site` and `GET /home`** — `settings` gains `licenceNo` and
`licenceIssuer` (from `licenceIssuerAr`/`licenceIssuerEn`): the primary
**published** licence's number and issuer, or `null` when there is none. They
are written by every licence write; `PUT admin/settings` refuses them (400).

**Admin (`admin/licences`, area `content`: admin and editor):**

| Route | Body / notes |
|---|---|
| `GET admin/licences` | paged `{data, total, page, limit}`; `?q=` searches title/number; `?published=true|false` |
| `GET admin/licences/:id` | the raw row |
| `POST admin/licences` | `titleAr` (required, ≤ 191), `titleEn` (≤ 191), `number` (≤ 100), `issuerAr`, `issuerEn` (≤ 190), `issuedOn`, `expiresOn` (`YYYY-MM-DD`), `assetId` (media asset id), `isPrimary`, `isPublished`, `sortOrder` — all but `titleAr` optional/nullable |
| `PATCH admin/licences/:id` | any subset of the above |
| `PATCH admin/licences/:id/publish` | `{isPublished?: boolean}` (default true) |
| `PATCH admin/licences/:id/primary` | no body — makes it the one primary licence |
| `POST admin/licences/reorder` | `[{id, sortOrder}]` |
| `DELETE admin/licences/:id` | `{deleted: true}` |

Rules: at most one licence is primary (making one primary clears the
others); an `assetId` that doesn't exist is 400 `VALIDATION_FAILED` with
`field: "assetId"`; an image asset needs Arabic alt text (409
`ALT_TEXT_REQUIRED`); `expiresOn` before `issuedOn` is 400. Deleting a media
asset a licence uses is 409 `ASSET_IN_USE` with
`usages: [{entity: "licences", id, label}]`.

022 turned the documents filed under the old `licences` category into
licences (title, file and visibility carried over; no number, issuer or
primary yet).

## Organisational structure (023, branch `feat/org-chart`)

The association's org chart («الهيكل التنظيمي»), ported from ta3lom. A tree
of positions; a board or executive member can hold one, and a position shows
the names of its published holders.

### Public

`GET org-chart` → a forest, published positions only, siblings in
`sortOrder`:

```ts
interface OrgNode {
  id: string;
  name: string;            // locale-collapsed (nameAr/nameEn)
  tone: 'neutral' | 'sky' | 'green' | 'brand';  // `auto` already resolved by depth
  holders: { id: string; name: string }[];       // [] unless the position shows holders
  children: OrgNode[];
}
```

A position under an unpublished parent is hidden with its whole branch; only
published members appear as holders. Cached under `org_chart`, purged by
every admin/org-positions and admin/board write.

### Admin (`content` area)

| Route | Body / result |
|---|---|
| `GET admin/org-positions` | paged `{data, total, page, limit}`; `?q=`, `?published=`, `?parentId=` |
| `GET admin/org-positions/:id` | the raw row |
| `POST admin/org-positions` | `nameAr` (required, ≤ 190), `nameEn`, `parentId` (or null for a top box), `tone` (`auto` default, `neutral`, `sky`, `green`, `brand`), `showHolders` (default true), `isPublished` (default true), `sortOrder` |
| `PATCH admin/org-positions/:id` | any subset of the above |
| `PATCH admin/org-positions/:id/publish` | `{isPublished?: boolean}` |
| `POST admin/org-positions/reorder` | `[{id, sortOrder}]` |
| `DELETE admin/org-positions/:id` | `{deleted: true}` |

Rules: `parentId` is 400 `VALIDATION_FAILED` with `field: "parentId"` and
`reason` one of `SELF_PARENT`, `PARENT_NOT_FOUND`, `CYCLE` (reports to one of
its own sub-positions), `TOO_DEEP` (more than 5 levels, counted including the
position's own sub-tree). A new position, or one moved to another parent,
goes last among its siblings unless `sortOrder` is sent. Deleting a position
that sub-positions or members still point at is 409 `RESOURCE_IN_USE` with
`usages: [{entity: "org_positions" | "board_members", id, label}]`.

`admin/board` rows gain `orgPositionId` (nullable); an id that doesn't exist
is 400 `VALIDATION_FAILED` with `field: "orgPositionId"`.
