import type { ApplicationStatus } from '../database/entities/application.entity.js';

export type TimelineState = 'done' | 'now' | 'pending';

export interface TimelineStep {
  key: 'received' | 'documents' | 'review' | 'interview' | 'decision';
  state: TimelineState;
}

const STEPS: TimelineStep['key'][] = ['received', 'documents', 'review', 'interview', 'decision'];

/**
 * The 5-step timeline the prototype's portal-status screen shows
 * ("received → documents → review (now) → interview → decision" — the
 * plan's Context section), derived purely from `applications.status` plus,
 * for the one ambiguous case, whether an interview was ever booked.
 *
 * Deliberately status-driven rather than event-driven: `application_events`
 * is an open-ended, staff-authored log (its own entity comment says "the
 * admin-applications module ... owns the actual vocabulary"), so deriving
 * the timeline from it would mean this portal-facing derivation breaks
 * silently the moment phase 7 adds a new event type it didn't expect.
 * `status` is the one column every phase agrees is authoritative for where
 * an application currently stands.
 *
 * - `draft` — nothing has been submitted yet; every step is `pending`
 *   (there is deliberately no `now` here — an in-progress, unsubmitted
 *   draft has no "current stage" in the reviewer pipeline this timeline
 *   describes).
 * - `new` / `under_review` — received & documents are `done` (submit()
 *   already required all 3 required doc types before flipping the
 *   status), review is `now`.
 * - `docs_missing` — received stays `done`, but documents regresses to
 *   `now`: the applicant has something to act on, and review has not
 *   meaningfully progressed while a required document is outstanding.
 * - `interview` — received/documents/review are `done`, interview is
 *   `now`.
 * - `accepted` — everything through decision is `done`.
 * - `rejected` — a terminal decision, so `decision` is `done`; whether
 *   `interview` shows `done` or stayed `pending` depends on whether one
 *   was ever booked (`hadInterview`), since a rejection can happen either
 *   straight out of review or after an interview.
 */
export function deriveTimeline(status: ApplicationStatus, hadInterview: boolean): TimelineStep[] {
  const state: Record<TimelineStep['key'], TimelineState> = {
    received: 'pending',
    documents: 'pending',
    review: 'pending',
    interview: 'pending',
    decision: 'pending',
  };

  switch (status) {
    case 'draft':
      break;
    case 'new':
    case 'under_review':
      state.received = 'done';
      state.documents = 'done';
      state.review = 'now';
      break;
    case 'docs_missing':
      state.received = 'done';
      state.documents = 'now';
      break;
    case 'interview':
      state.received = 'done';
      state.documents = 'done';
      state.review = 'done';
      state.interview = 'now';
      break;
    case 'accepted':
      state.received = 'done';
      state.documents = 'done';
      state.review = 'done';
      state.interview = 'done';
      state.decision = 'done';
      break;
    case 'rejected':
      state.received = 'done';
      state.documents = 'done';
      state.review = 'done';
      state.interview = hadInterview ? 'done' : 'pending';
      state.decision = 'done';
      break;
  }

  return STEPS.map((key) => ({ key, state: state[key] }));
}
