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
 * The 'log'/'http' driver switch (Safeer infra change §4) — mirrors
 * MailTransportService's role, but there is no persistent client object to
 * cache here (a `fetch` call needs nothing built ahead of time the way a
 * nodemailer transporter does), so this is a stateless delivery function
 * rather than a cached-transporter service.
 *
 * `http` is a generic, unauthenticated-vendor placeholder: it POSTs
 * `{to, message, sender}` as JSON with a bearer token if one is configured,
 * and is otherwise untested — there is no real SMS vendor wired up. `log`
 * (the seeded default) never leaves the process: it only writes to the
 * Nest logger, which is enough for local development and for the smoke
 * suite to read an OTP code back out of `sms_log` directly.
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

    if (!settings.providerUrl) {
      return { ok: false, error: 'SMS HTTP driver is not configured — set a provider URL first' };
    }

    const token = settings.tokenEncrypted ? decryptSecret(settings.tokenEncrypted, this.env.APP_ENCRYPTION_KEY) : null;

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
}
