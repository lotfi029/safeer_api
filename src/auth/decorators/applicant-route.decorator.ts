import { SetMetadata } from '@nestjs/common';

export const IS_APPLICANT_ROUTE_KEY = 'isApplicantRoute';

/**
 * Marks a student-portal handler (Safeer infra change §2). `SessionGuard`
 * resolves the `sf_app_sid` cookie against `applicant_sessions` for these
 * handlers instead of the staff `sf_sid` cookie against `sessions`, and sets
 * `req.applicant = { applicationId }` plus `req.sessionTokenHash` — the
 * latter is what lets the existing `CsrfGuard` protect portal writes with no
 * change of its own. Staff cookies are never accepted here, and an applicant
 * cookie is never accepted on a route without this decorator.
 */
export const ApplicantRoute = () => SetMetadata(IS_APPLICANT_ROUTE_KEY, true);
