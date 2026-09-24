import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import nodemailer, { type Transporter } from 'nodemailer';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { decryptSecret } from './mail-crypto.js';

export interface FromHeader {
  fromNameAr: string | null;
  fromNameEn: string | null;
  fromEmail: string | null;
  replyTo: string | null;
}

/**
 * The nodemailer transport, built from `mail_settings` and cached until
 * something calls `invalidate()` (13-backend-build-plan.md P10 step 2) — the
 * settings PUT handler does that after every save, so a changed host/port/
 * password takes effect on the very next send without restarting the
 * process. `driver !== 'smtp'` (the seeded default is `'log'`) yields no
 * transporter at all; callers treat that the same as "not configured".
 */
@Injectable()
export class MailTransportService {
  private transporter: Transporter | null = null;
  private builtForUpdatedAt: string | null = null;

  constructor(
    @InjectRepository(MailSettings) private readonly repo: Repository<MailSettings>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getTransporter(): Promise<{ transporter: Transporter | null; settings: MailSettings }> {
    const settings = await this.repo
      .createQueryBuilder('m')
      .addSelect('m.passwordEncrypted')
      .where('m.id = :id', { id: '1' })
      .getOne();
    if (!settings) {
      throw new Error('mail_settings singleton row is missing — has 002_seed.sql been applied?');
    }

    const cacheKey = settings.updatedAt.toISOString();
    if (!this.transporter || this.builtForUpdatedAt !== cacheKey) {
      this.transporter = this.build(settings);
      this.builtForUpdatedAt = cacheKey;
    }

    return { transporter: this.transporter, settings };
  }

  invalidate(): void {
    this.transporter = null;
    this.builtForUpdatedAt = null;
  }

  fromHeader(settings: FromHeader, locale: 'ar' | 'en'): string {
    const rawName = (locale === 'en' && settings.fromNameEn) || settings.fromNameAr || settings.fromEmail || '';
    // CRLF header-injection guard: fromNameAr/fromNameEn are free-text admin
    // input with no character restriction (mail-settings.dto.ts validates
    // fromEmail/replyTo as email addresses, which rejects whitespace, but
    // not the display name), and this string is interpolated directly into
    // a raw header handed to nodemailer — a newline here could inject an
    // additional SMTP header.
    const name = rawName.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
    return settings.fromEmail ? `"${name}" <${settings.fromEmail}>` : (settings.fromEmail ?? '');
  }

  private build(settings: MailSettings): Transporter | null {
    if (settings.driver !== 'smtp' || !settings.host || !settings.port) {
      return null;
    }
    const password = settings.passwordEncrypted ? decryptSecret(settings.passwordEncrypted, this.env.APP_ENCRYPTION_KEY) : undefined;
    return nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.encryption === 'tls',
      requireTLS: settings.encryption === 'starttls',
      auth: settings.username ? { user: settings.username, pass: password } : undefined,
    });
  }
}
