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

