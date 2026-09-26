import type { Locale } from '../common/request-context.js';

export const MAIL_SERVICE = Symbol('MAIL_SERVICE');

export interface SendMailParams {
  /** contact_ack | contact_notify | user_invite | password_reset | donation_receipt */
  key: string;
  to: string;
  vars: Record<string, string>;
  locale: Locale;
  entity?: { type: string; id: string };
  /**
   * C1: variables that must never be stored — an OTP `code`. The `mail_log`
   * row's subject gets them masked and no payload is stored at all; the
   * real rendering lives only in this process's in-memory queue, so the
   * mail can't be retried after a restart (an OTP has expired by then anyway).
   */
  sensitiveVars?: readonly string[];
}

/**
 * P6 depends on this interface, bound to a no-op, so invitations and
 * password resets have somewhere to call into before the real mail service
 * exists. P10 replaces the binding with the real queue-backed
 * implementation — a one-line provider change, nothing else moves.
 */
export interface MailServiceInterface {
  send(params: SendMailParams): Promise<void>;
}
