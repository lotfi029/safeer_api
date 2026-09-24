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
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
