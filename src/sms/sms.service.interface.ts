import type { Locale } from '../common/request-context.js';

export const SMS_SERVICE = Symbol('SMS_SERVICE');

export interface SendSmsParams {
  /** otp_code | application_submitted | application_status_changed | documents_requested | application_resume */
  key: string;
  to: string;
  vars: Record<string, string>;
  locale: Locale;
  entity?: { type: string; id: string };
}

export type SmsSendStatus = 'sent' | 'failed' | 'skipped';

export interface SendSmsResult {
  status: SmsSendStatus;
}

/**
 * Whether SMS is currently able to actually reach a phone, from
 * sms_settings: 'disabled' (is_enabled = 0), 'log' (enabled, but the
 * 'log' driver only ever writes sms_log and sends nothing), or 'real' (a
 * live driver, e.g. 'unifonic'/'http'). B1 (safeer-backend-fr-review.md):
 * PortalOtpService uses this to decide whether SMS is worth attempting at
 * all before falling back to email.
 */
export type SmsAvailability = 'real' | 'log' | 'disabled';

/** Mirrors MailServiceInterface (src/mail/mail.service.interface.ts) — same shape, a different channel. */
export interface SmsServiceInterface {
  send(params: SendSmsParams): Promise<SendSmsResult>;
  availability(): Promise<SmsAvailability>;
}
