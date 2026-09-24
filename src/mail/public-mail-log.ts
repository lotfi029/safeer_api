import type { MailLog, MailLocale, MailLogStatus } from '../database/entities/mail-log.entity.js';

/**
 * 26-backend-code-review.md H3: `MailLog.payload` is the rendered
 * subject/html/text — for `password_reset` and `user_invite`, that includes
 * the raw one-time token in the link. `mail.service.ts` goes to real trouble
 * to null it the moment a row reaches a terminal state (`sent` or terminal
 * `failed`), specifically so a reset link doesn't sit in the database for
 * the log's full 90-day retention, only the ≤21-minute retry window.
 *
 * Two call sites defeated that: `MailLogController.list()` serialised the
 * raw entity (so any admin browsing the log saw every other user's
 * in-flight reset/invite link), and `MailLogController.retry()` assigned
 * the raw entity to `req.auditContext.after`, which `AuditInterceptor`
 * writes into `audit_log.diff` — append-only, no retention sweep, no DELETE
 * grant, so a plaintext link that reached the audit log stayed there
 * permanently. This projection is the fix for both: `hasPayload` still
 * tells an admin whether the row is retryable without ever exposing the
 * contents.
 */
export interface PublicMailLog {
  id: string;
  templateKey: string;
  locale: MailLocale;
  toEmail: string;
  subject: string;
  status: MailLogStatus;
  attempts: number;
  error: string | null;
  hasPayload: boolean;
  entityType: string | null;
  entityId: string | null;
  nextRetryAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

export function toPublicMailLog(log: MailLog): PublicMailLog {
  return {
    id: log.id,
    templateKey: log.templateKey,
    locale: log.locale,
    toEmail: log.toEmail,
    subject: log.subject,
    status: log.status,
    attempts: log.attempts,
    error: log.error,
    hasPayload: log.payload !== null,
    entityType: log.entityType,
    entityId: log.entityId,
    nextRetryAt: log.nextRetryAt,
    sentAt: log.sentAt,
    createdAt: log.createdAt,
  };
}
