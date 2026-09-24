/**
 * Machine error codes the Angular layer maps to an Arabic/English message
 * (11-architecture.md §3, 13-backend-build-plan.md P5).
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  ASSET_IN_USE: 'ASSET_IN_USE',
  RESOURCE_IN_USE: 'RESOURCE_IN_USE',
  ALT_TEXT_REQUIRED: 'ALT_TEXT_REQUIRED',
  LAST_ADMIN: 'LAST_ADMIN',
  SLUG_TAKEN: 'SLUG_TAKEN',
  PUBLISH_BLOCKED: 'PUBLISH_BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_PROVIDER: 'UNSUPPORTED_PROVIDER',
  SOURCE_TYPE_MISMATCH: 'SOURCE_TYPE_MISMATCH',
  UNKNOWN_VARIABLE: 'UNKNOWN_VARIABLE',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /** 7.3: distinct from FEATURE_DISABLED — the flag is on, but no payment provider is wired up yet. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  /** Phase 6 (apply flow/portal): a write to `applications` was attempted while its `status` is not `draft`/`docs_missing`. */
  APPLICATION_LOCKED: 'APPLICATION_LOCKED',
  /** Phase 6: `portal/auth/verify-otp` — wrong code, expired, no matching row, or the 5-attempt cap was hit. Deliberately one generic code for every failure branch (non-enumeration). */
  OTP_INVALID: 'OTP_INVALID',
  /** Phase 6: `portal/application/submit` — one or more of the 3 required document types has no current, non-rejected document. `extra.missing` lists the doc types still needed. */
  DOCUMENTS_INCOMPLETE: 'DOCUMENTS_INCOMPLETE',
  /** Phase 6: `portal/interview` — the chosen slot was already booked (or no longer open) by the time the row was locked. */
  SLOT_ALREADY_BOOKED: 'SLOT_ALREADY_BOOKED',
  /** Phase 6: `portal/interview-slots` and `portal/interview` — the application's `status` is not `interview`. */
  INTERVIEW_NOT_AVAILABLE: 'INTERVIEW_NOT_AVAILABLE',
  /**
   * Phase 7 (admin applications): `PATCH admin/applications/:id`, the
   * `status` bulk action, and `POST .../request-documents` all validate
   * against `admin-applications/transitions.ts`'s allowed-transition map
   * before writing anything. Thrown for any disallowed `from`→`to` pair,
   * including every attempt to move into or out of `draft` from this admin
   * surface (`draft`→`new` only ever happens through the applicant's own
   * submit) — `extra.from`/`extra.to` name the rejected pair.
   */
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
