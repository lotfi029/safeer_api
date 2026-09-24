import type { ApplicationStatus } from '../database/entities/application.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

/**
 * The staff-driven status transition map for `PATCH admin/applications/:id`
 * and the `status` bulk action (admin-applications.service.ts).
 *
 * `draft` is deliberately absent from every target list AND has no outgoing
 * edges of its own: `draft -> new` only ever happens through the
 * applicant's own `POST portal/application/submit`
 * (portal-application.service.ts), never through this admin route, so a
 * draft application is untouchable here in either direction until the
 * applicant submits it themselves.
 *
 * `docs_missing`'s only outgoing edge is back to `under_review` — a staff
 * member manually confirming the requested documents are now satisfactory.
 * Phase 6's `portal-documents.service.ts` deliberately never auto-transitions
 * out of `docs_missing` on a re-upload ("the event is recorded so a
 * reviewer sees it; the status transition is theirs to make") — this map is
 * that promised "theirs to make" step.
 *
 * `accepted`/`rejected` are terminal — no outgoing edges — matching the
 * portal timeline's own treatment of them as decision states
 * (portal-timeline.ts).
 */
export const APPLICATION_STATUS_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: [],
  new: ['under_review'],
  under_review: ['docs_missing', 'interview', 'accepted', 'rejected'],
  docs_missing: ['under_review'],
  interview: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

/**
 * `POST admin/applications/:id/request-documents` (and the equivalent bulk
 * action) also sets `docs_missing`, but from a broader set of starting
 * points than a plain `PATCH status=docs_missing` allows above — a reviewer
 * can find documents lacking while an application is still `new` (before
 * formal review has started) or mid-`interview`, not only from
 * `under_review`. This is a separate, narrower-purpose check rather than
 * folding those extra edges into the main map, specifically because
 * request-documents always pairs the transition with its own
 * `DOCS_REQUESTED` event and `documents_requested` mail/SMS — a caller
 * wanting the generic `STATUS_CHANGED` event instead uses the main PATCH
 * route, which only allows `docs_missing` from `under_review`.
 */
export const REQUEST_DOCUMENTS_ALLOWED_FROM: ApplicationStatus[] = ['new', 'under_review', 'interview'];

export function assertStatusTransition(current: ApplicationStatus, target: ApplicationStatus): void {
  const allowed = APPLICATION_STATUS_TRANSITIONS[current] ?? [];
  if (!allowed.includes(target)) {
    throw new ProblemException(
      409,
      ErrorCode.INVALID_STATUS_TRANSITION,
      `Cannot change application status from '${current}' to '${target}'`,
      { from: current, to: target },
    );
  }
}

export function assertRequestDocumentsAllowed(current: ApplicationStatus): void {
  if (!REQUEST_DOCUMENTS_ALLOWED_FROM.includes(current)) {
    throw new ProblemException(
      409,
      ErrorCode.INVALID_STATUS_TRANSITION,
      `Documents cannot be requested while the application is '${current}'`,
      { from: current, to: 'docs_missing' },
    );
  }
}
