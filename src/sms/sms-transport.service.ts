import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { decryptSecret } from '../mail/mail-crypto.js';
import type { SmsSettings } from '../database/entities/sms-settings.entity.js';

export interface SmsDeliveryResult {
  ok: boolean;
  error?: string;
}

/**
 * The 'log'/'http'/'unifonic' driver switch (Safeer infra change §4, B1 in
 * safeer-backend-fr-review.md) — mirrors MailTransportService's role, but
 * there is no persistent client object to cache here (a `fetch` call needs
 * nothing built ahead of time the way a nodemailer transporter does), so
 * this is a stateless delivery function rather than a cached-transporter
 * service.
 *
 * `unifonic` is the real Saudi SMS vendor (see `deliverUnifonic` below).
 * `http` is a generic, unauthenticated-vendor placeholder: it POSTs
 * `{to, message, sender}` as JSON with a bearer token if one is configured,
 * and is otherwise untested — kept for a future vendor that fits that
 * shape. `log` (the seeded default) never leaves the process: it only
 * writes to the Nest logger, which is enough for local development and for
 * the smoke suite to read an OTP code back out of `sms_log` directly.
 */
@Injectable()
export class SmsTransportService {
  private readonly logger = new Logger(SmsTransportService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async deliver(settings: SmsSettings, to: string, message: string): Promise<SmsDeliveryResult> {
    if (settings.driver === 'log') {
      this.logger.log(`[SMS to ${to}] ${message}`);
      return { ok: true };
    }

    const token = settings.tokenEncrypted ? decryptSecret(settings.tokenEncrypted, this.env.APP_ENCRYPTION_KEY) : null;

    if (settings.driver === 'unifonic') {
      return this.deliverUnifonic(settings, token, to, message);
    }

    if (!settings.providerUrl) {
      return { ok: false, error: 'SMS HTTP driver is not configured — set a provider URL first' };
    }

    try {
      const response = await fetch(settings.providerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ to, message, sender: settings.senderName ?? undefined }),
      });
      if (!response.ok) {
        return { ok: false, error: `Provider responded with HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Unifonic REST API (decision 4, safeer-backend-fix-prompt.md) — a Saudi
   * SMS gateway. `token_encrypted` holds the account's AppSid,
   * `sender_name` its approved SenderID; `provider_url` optionally
   * overrides the default endpoint (a different Unifonic region/base URL).
   * Success is `success: true` in the JSON body — Unifonic returns HTTP 200
   * for some rejected sends too, so the HTTP status alone isn't enough.
   */
  private async deliverUnifonic(
    settings: SmsSettings,
    token: string | null,
    to: string,
    message: string,
  ): Promise<SmsDeliveryResult> {
    if (!token) {
      return { ok: false, error: 'Unifonic driver is not configured — set the AppSid token first' };
    }
    if (!settings.senderName) {
      return { ok: false, error: 'Unifonic driver is not configured — set a SenderID (sender name) first' };
    }

    const endpoint = settings.providerUrl || 'https://el.cloud.unifonic.com/rest/SMS/messages';
    const recipient = to.replace(/^\+/, '');

    const body = new URLSearchParams({
      AppSid: token,
      SenderID: settings.senderName,
      Recipient: recipient,
      Body: message,
      responseType: 'JSON',
    });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json().catch(() => null)) as
        | { success?: boolean | string; message?: string; errorCode?: string | number }
        | null;
      const success = data?.success === true || data?.success === 'true';
      if (!response.ok || !success) {
        const detail = data?.message ?? `HTTP ${response.status}`;
        const code = data?.errorCode !== undefined ? ` (${data.errorCode})` : '';
        return { ok: false, error: `Unifonic: ${detail}${code}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
