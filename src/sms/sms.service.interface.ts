import type { Locale } from '../common/request-context.js';

export const SMS_SERVICE = Symbol('SMS_SERVICE');

export interface SendSmsParams {
  /** otp_code | application_submitted | application_status_changed | documents_requested */
  key: string;
  to: string;
  vars: Record<string, string>;
  locale: Locale;
  entity?: { type: string; id: string };
}

/** Mirrors MailServiceInterface (src/mail/mail.service.interface.ts) — same shape, a different channel. */
export interface SmsServiceInterface {
  send(params: SendSmsParams): Promise<void>;
}
