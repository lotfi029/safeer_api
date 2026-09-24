import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { encryptSecret } from './mail-crypto.js';
import { MailTransportService } from './mail-transport.service.js';
import type { UpdateMailSettingsDto } from './dto/mail-settings.dto.js';

const SINGLETON_ID = '1';

@Injectable()
export class MailSettingsService {
  constructor(
    @InjectRepository(MailSettings) private readonly repo: Repository<MailSettings>,
    @Inject(ENV) private readonly env: Env,
    private readonly transport: MailTransportService,
  ) {}

  async get(): Promise<MailSettings & { passwordIsSet: boolean }> {
    const settings = await this.findSingleton();
    return { ...settings, passwordIsSet: await this.hasPassword() };
  }

  /** `UPDATE`, never `INSERT` (trap 5) — `002_seed.sql` always inserts the one row. */
  async update(dto: UpdateMailSettingsDto, userId: string) {
    const settings = await this.findSingleton();
    const passwordWasSet = await this.hasPassword();
    const before = { ...settings, passwordIsSet: passwordWasSet };

    const { password, ...rest } = dto;
    Object.assign(settings, rest);
    // trap 12: an omitted or empty password must never blank the stored
    // one. `passwordEncrypted` is `select: false`, so `settings` doesn't
    // carry it unless this branch sets it — TypeORM's save() only writes
    // columns actually present on the entity instance, so leaving it unset
    // here means the UPDATE never touches that column at all.
    if (password) {
      settings.passwordEncrypted = encryptSecret(password, this.env.APP_ENCRYPTION_KEY);
    }
    settings.updatedBy = userId;

    const saved = await this.repo.save(settings);
    this.transport.invalidate();

    const after = { ...saved, passwordIsSet: password ? true : passwordWasSet } as Omit<MailSettings, 'passwordEncrypted'> & {
      passwordIsSet: boolean;
      passwordEncrypted?: Buffer;
    };
    delete after.passwordEncrypted;

    return { before, after };
  }

  /** Sends immediately and synchronously, and reports the provider's real error text (FR-E-03) rather than throwing. */
  async test(to: string): Promise<{ ok: boolean; error?: string }> {
    const { transporter, settings } = await this.transport.getTransporter();
    if (!transporter) {
      const error = 'SMTP is not configured — set driver to "smtp" with a host and port first';
      await this.recordTestResult(false, error);
      return { ok: false, error };
    }

    try {
      await transporter.sendMail({
        from: this.transport.fromHeader(settings, 'ar'),
        to,
        subject: 'رسالة اختبار — Safeer test message',
        text: 'This is a test message sent from the Safeer admin dashboard.',
      });
      await this.recordTestResult(true, null);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.recordTestResult(false, error);
      return { ok: false, error };
    }
  }

  private async recordTestResult(ok: boolean, error: string | null): Promise<void> {
    await this.repo.update(
      { id: SINGLETON_ID },
      { lastTestAt: new Date(), lastTestOk: ok, lastTestError: error ? error.slice(0, 500) : null },
    );
  }

  private async findSingleton(): Promise<MailSettings> {
    const row = await this.repo.findOne({ where: { id: SINGLETON_ID } });
    if (!row) throw new Error('mail_settings singleton row is missing — has 002_seed.sql been applied?');
    return row;
  }

  private async hasPassword(): Promise<boolean> {
    const rows = await this.repo.manager.query<{ hasPassword: number }[]>(
      'SELECT password_encrypted IS NOT NULL AS hasPassword FROM mail_settings WHERE id = ?',
      [SINGLETON_ID],
    );
    return Boolean(rows[0]?.hasPassword);
  }
}
