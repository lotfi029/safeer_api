import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsLog } from '../database/entities/sms-log.entity.js';
import { SmsSettings } from '../database/entities/sms-settings.entity.js';
import type { SmsServiceInterface, SendSmsParams, SendSmsResult, SmsAvailability } from './sms.service.interface.js';
import { SmsTemplatesService } from './sms-templates.service.js';
import { SmsTransportService } from './sms-transport.service.js';
import { maskVars } from '../common/sensitive-vars.js';

interface PreparedSms {
  logId: string;
  settings: SmsSettings;
  to: string;
  message: string;
  /** `message` with sensitive variables masked — what the `log` driver prints. */
  loggable: string;
}

/**
 * The real SmsService (Safeer infra change §4), bound to SMS_SERVICE in
 * sms.module.ts exactly like MailService is bound to MAIL_SERVICE.
 *
 * C21: `send()` is queue-and-return — it writes the `sms_log` row as
 * `queued` and delivers in the background, so a slow or hanging provider
 * never holds a request (or a 200-item bulk action) open. `sendNow()` is the
 * awaited variant for the OTP request, which needs the outcome to decide on
 * the email fallback (B1). Both are bounded by the transport's 5 s timeout
 * and make exactly one delivery attempt (no retry sweep yet — `attempts`
 * only ever reaches 1).
 *
 * C1: `sensitiveVars` (the OTP `code`) are masked in everything stored or
 * logged; only the text handed to the provider carries the real value.
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

  async send(params: SendSmsParams): Promise<void> {
    try {
      const prepared = await this.prepare(params);
      if (!prepared) return;
      void this.deliver(prepared);
    } catch (err) {
      this.logger.error('SmsService.send failed', err instanceof Error ? err.stack : String(err));
    }
  }

  async sendNow(params: SendSmsParams): Promise<SendSmsResult> {
    try {
      const prepared = await this.prepare(params);
      if (!prepared) return { status: 'skipped' };
      return await this.deliver(prepared);
    } catch (err) {
      this.logger.error('SmsService.sendNow failed', err instanceof Error ? err.stack : String(err));
      return { status: 'failed' };
    }
  }

  /**
   * Renders the message (real and masked), writes the `sms_log` row, and
   * returns what `deliver` needs — or null when the send is `skipped`
   * (`is_enabled = 0` globally or for the template, or no recipient, named
   * in `error`).
   */
  private async prepare(params: SendSmsParams): Promise<PreparedSms | null> {
    const settings = await this.settingsRepo
      .createQueryBuilder('s')
      .addSelect('s.tokenEncrypted')
      .where('s.id = :id', { id: '1' })
      .getOne();
    const rendered = await this.templates.render(params.key, params.vars, params.locale);
    const loggable = params.sensitiveVars?.length
      ? await this.templates.render(params.key, maskVars(params.vars, params.sensitiveVars), params.locale)
      : rendered;
    const missingRecipient = !params.to;
    const skipped = missingRecipient || !settings?.isEnabled || !rendered;

    const row = await this.logRepo.save(
      this.logRepo.create({
        templateKey: params.key,
        locale: params.locale,
        toPhone: params.to,
        message: loggable ?? params.key,
        status: skipped ? 'skipped' : 'queued',
        error: !skipped
          ? null
          : missingRecipient
            ? 'No recipient phone number was configured for this send'
            : !settings?.isEnabled
              ? 'SMS is disabled in sms_settings'
              : 'Template is disabled or missing',
        entityType: params.entity?.type ?? null,
        entityId: params.entity?.id ?? null,
      }),
    );
    if (skipped || !settings || !rendered) return null;
    return { logId: row.id, settings, to: params.to, message: rendered, loggable: loggable ?? rendered };
  }

  private async deliver(prepared: PreparedSms): Promise<SendSmsResult> {
    try {
      const result = await this.transport.deliver(prepared.settings, prepared.to, prepared.message, prepared.loggable);
      await this.logRepo.update(prepared.logId, {
        status: result.ok ? 'sent' : 'failed',
        attempts: 1,
        error: result.ok ? null : (result.error ?? 'Unknown delivery error').slice(0, 1000),
        sentAt: result.ok ? new Date() : null,
      });
      return { status: result.ok ? 'sent' : 'failed' };
    } catch (err) {
      this.logger.error(`SMS delivery ${prepared.logId} failed`, err instanceof Error ? err.stack : String(err));
      await this.logRepo
        .update(prepared.logId, { status: 'failed', attempts: 1, error: 'Unexpected delivery error' })
        .catch(() => undefined);
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
