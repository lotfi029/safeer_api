import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsLog } from '../database/entities/sms-log.entity.js';
import { SmsSettings } from '../database/entities/sms-settings.entity.js';
import type { SmsServiceInterface, SendSmsParams, SendSmsResult, SmsAvailability } from './sms.service.interface.js';
import { SmsTemplatesService } from './sms-templates.service.js';
import { SmsTransportService } from './sms-transport.service.js';

/**
 * The real SmsService (Safeer infra change §4), bound to SMS_SERVICE in
 * sms.module.ts exactly like MailService is bound to MAIL_SERVICE.
 *
 * Deliberate simplification versus MailService: **no retry queue**. Every
 * `send()` makes exactly one delivery attempt, synchronously, before
 * returning. `sms_log` still has the same status/attempts/next_retry_at
 * shape as `mail_log` (for parity and to leave room for a real queue
 * later), but `attempts` only ever reaches 1 and `next_retry_at` stays
 * NULL. The reasoning: mail's 1+5+15-minute backoff exists because a real
 * SMTP provider is already wired up and transient failures (a momentary
 * network blip, a provider rate limit) are worth retrying automatically.
 * SMS today has only the 'log' driver (never fails) and a generic,
 * completely untested 'http' driver with no real vendor behind it — building
 * a retry sweep against a driver nothing yet exercises would be untestable
 * speculation. Adding one later is additive: extend this service the same
 * way MailService.sweepRetries()/attemptDelivery() work, no schema change
 * required.
 */
@Injectable()
export class SmsService implements SmsServiceInterface {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @InjectRepository(SmsLog) private readonly logRepo: Repository<SmsLog>,
    @InjectRepository(SmsSettings) private readonly settingsRepo: Repository<SmsSettings>,
    private readonly templates: SmsTemplatesService,
    private readonly transport: SmsTransportService,
  ) {}

  /**
   * Writes an `sms_log` row and never throws into the caller (mirrors
   * mail.service.ts's trap 13). `is_enabled = 0` (globally, or the specific
   * template disabled) writes the row `skipped` and sends nothing, same as
   * mail. An empty `params.to` is its own `skipped` cause, named in `error`.
   *
   * Returns the outcome (B1, safeer-backend-fr-review.md) so a caller —
   * `PortalOtpService.requestOtp` — can fall back to email when this
   * doesn't come back `sent`, without needing to re-read `sms_log` itself.
   */
  async send(params: SendSmsParams): Promise<SendSmsResult> {
    try {
      const settings = await this.settingsRepo
        .createQueryBuilder('s')
        .addSelect('s.tokenEncrypted')
        .where('s.id = :id', { id: '1' })
        .getOne();
      const rendered = await this.templates.render(params.key, params.vars, params.locale);
      const missingRecipient = !params.to;

      if (missingRecipient || !settings?.isEnabled || !rendered) {
        await this.logRepo.save(
          this.logRepo.create({
            templateKey: params.key,
            locale: params.locale,
            toPhone: params.to,
            message: rendered ?? params.key,
            status: 'skipped',
            error: missingRecipient
              ? 'No recipient phone number was configured for this send'
              : !settings?.isEnabled
                ? 'SMS is disabled in sms_settings'
                : 'Template is disabled or missing',
            entityType: params.entity?.type ?? null,
            entityId: params.entity?.id ?? null,
          }),
        );
        return { status: 'skipped' };
      }

      const result = await this.transport.deliver(settings, params.to, rendered);

      await this.logRepo.save(
        this.logRepo.create({
          templateKey: params.key,
          locale: params.locale,
          toPhone: params.to,
          message: rendered,
          status: result.ok ? 'sent' : 'failed',
          attempts: 1,
          error: result.ok ? null : (result.error ?? 'Unknown delivery error').slice(0, 1000),
          entityType: params.entity?.type ?? null,
          entityId: params.entity?.id ?? null,
          sentAt: result.ok ? new Date() : null,
        }),
      );
      return { status: result.ok ? 'sent' : 'failed' };
    } catch (err) {
      this.logger.error('SmsService.send failed', err instanceof Error ? err.stack : String(err));
      return { status: 'failed' };
    }
  }

  /**
   * `is_enabled = 0` -> 'disabled'. Driver 'log' -> 'log' (never leaves the
   * process). Anything else (a real, configured driver) -> 'real'. B1: this
   * is what `PortalOtpService` checks before deciding whether SMS is worth
   * attempting for a given request, and what `request-otp`'s `channelHint`
   * reflects when the caller doesn't specify a channel.
   */
  async availability(): Promise<SmsAvailability> {
    const settings = await this.settingsRepo.findOne({ where: { id: '1' } });
    if (!settings?.isEnabled) return 'disabled';
    return settings.driver === 'log' ? 'log' : 'real';
  }
}
