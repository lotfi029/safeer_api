import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsSettings } from '../database/entities/sms-settings.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { encryptSecret } from '../mail/mail-crypto.js';
import { SmsTransportService } from './sms-transport.service.js';
import type { UpdateSmsSettingsDto } from './dto/sms-settings.dto.js';

const SINGLETON_ID = '1';

@Injectable()
export class SmsSettingsService {
  constructor(
    @InjectRepository(SmsSettings) private readonly repo: Repository<SmsSettings>,
    @Inject(ENV) private readonly env: Env,
    private readonly transport: SmsTransportService,
  ) {}

  async get(): Promise<SmsSettings & { tokenIsSet: boolean }> {
    const settings = await this.findSingleton();
    return { ...settings, tokenIsSet: await this.hasToken() };
  }

  /** `UPDATE`, never `INSERT` (mirrors mail-settings.service.ts's trap 5) — 002_seed.sql always inserts the one row. */
  async update(dto: UpdateSmsSettingsDto, userId: string) {
    const settings = await this.findSingleton();
    const tokenWasSet = await this.hasToken();
    const before = { ...settings, tokenIsSet: tokenWasSet };

    const { token, ...rest } = dto;
    Object.assign(settings, rest);
    // An omitted or empty token must never blank the stored one — same
    // discipline as mail_settings.password (trap 12).
    if (token) {
      settings.tokenEncrypted = encryptSecret(token, this.env.APP_ENCRYPTION_KEY);
    }
    settings.updatedBy = userId;

    const saved = await this.repo.save(settings);

    const after = { ...saved, tokenIsSet: token ? true : tokenWasSet } as Omit<SmsSettings, 'tokenEncrypted'> & {
      tokenIsSet: boolean;
      tokenEncrypted?: Buffer;
    };
    delete after.tokenEncrypted;

    return { before, after };
  }

  /** Sends immediately and synchronously, and reports the driver's own error text rather than throwing. */
  async test(to: string): Promise<{ ok: boolean; error?: string }> {
    const settings = await this.repo
      .createQueryBuilder('s')
      .addSelect('s.tokenEncrypted')
      .where('s.id = :id', { id: SINGLETON_ID })
      .getOne();
    if (!settings) throw new Error('sms_settings singleton row is missing — has 002_seed.sql been applied?');

    const result = await this.transport.deliver(settings, to, 'رسالة اختبار من لوحة تحكم سفير — Safeer test SMS');
    await this.recordTestResult(result.ok, result.error ?? null);
    return result;
  }

  private async recordTestResult(ok: boolean, error: string | null): Promise<void> {
    await this.repo.update(
      { id: SINGLETON_ID },
      { lastTestAt: new Date(), lastTestOk: ok, lastTestError: error ? error.slice(0, 500) : null },
    );
  }

  private async findSingleton(): Promise<SmsSettings> {
    const row = await this.repo.findOne({ where: { id: SINGLETON_ID } });
    if (!row) throw new Error('sms_settings singleton row is missing — has 002_seed.sql been applied?');
    return row;
  }

  private async hasToken(): Promise<boolean> {
    const rows = await this.repo.manager.query<{ hasToken: number }[]>(
      'SELECT token_encrypted IS NOT NULL AS hasToken FROM sms_settings WHERE id = ?',
      [SINGLETON_ID],
    );
    return Boolean(rows[0]?.hasToken);
  }
}
