import type { SmsLog, SmsLocale, SmsLogStatus } from '../database/entities/sms-log.entity.js';

/**
 * Mirrors public-mail-log.ts's H3 fix, applied from the start rather than
 * retrofitted: `sms_log.message` is the fully rendered text, and for
 * `otp_code` that means it contains the one-time code itself — closer to
 * mail_log's sensitive `payload` (never serialised) than to its harmless
 * `subject`. This projection leaves `message` out of every admin API
 * response for that reason. It is still visible via a direct database
 * query, which is deliberate: the plan's smoke suite reads a fresh OTP code
 * out of `sms_log` directly in dev, and that path never goes through this
 * projection or the admin API at all.
 */
export interface PublicSmsLog {
  id: string;
  templateKey: string;
  locale: SmsLocale;
  toPhone: string;
  status: SmsLogStatus;
  attempts: number;
  error: string | null;
  entityType: string | null;
  entityId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export function toPublicSmsLog(log: SmsLog): PublicSmsLog {
  return {
    id: log.id,
    templateKey: log.templateKey,
    locale: log.locale,
    toPhone: log.toPhone,
    status: log.status,
    attempts: log.attempts,
    error: log.error,
    entityType: log.entityType,
    entityId: log.entityId,
    sentAt: log.sentAt,
    createdAt: log.createdAt,
  };
}
