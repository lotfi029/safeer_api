import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContactMessage } from '../database/entities/contact-message.entity.js';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { NewsletterSubscriber } from '../database/entities/newsletter-subscriber.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import type { Locale } from '../common/request-context.js';
import type { ContactDto, NewsletterDto } from './dto/contact.dto.js';
import { frontendUrl } from '../common/links/frontend-url.js';
import { contactSubjectLabel } from '../common/labels.js';
import { issueNewsletterToken, verifyNewsletterToken } from './newsletter-token.util.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

const MIN_FORM_SECONDS = 3;

function isHoneypotTripped(dto: { website?: string; formRenderedAt: number }): boolean {
  if (dto.website) return true;
  // A negative elapsed value (formRenderedAt in the future — a device clock
  // a few seconds fast is enough) must not count as "too fast": only a
  // plausible fast-submit window (0 <= elapsed < threshold) is the actual
  // spam signal. formRenderedAt is unsigned client input, so this remains an
  // advisory check, not a hard guarantee, either way.
  const elapsedMs = Date.now() - dto.formRenderedAt;
  return elapsedMs >= 0 && elapsedMs < MIN_FORM_SECONDS * 1000;
}

@Injectable()
export class ContactService {
  constructor(
    @InjectRepository(ContactMessage) private readonly messageRepo: Repository<ContactMessage>,
    @InjectRepository(MailSettings) private readonly mailSettingsRepo: Repository<MailSettings>,
    @InjectRepository(NewsletterSubscriber) private readonly newsletterRepo: Repository<NewsletterSubscriber>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * The submission is stored **before** mail is enqueued, so a broken
   * mailbox never loses a message. A honeypot hit or a too-fast submission
   * is treated as spam — reported as success (never persisted, never
   * mailed) so a bot gets no signal that it was caught.
   */
  async submit(dto: ContactDto, ipHash: string | null, userAgent: string | null, locale: Locale): Promise<{ ok: true }> {
    if (isHoneypotTripped(dto)) {
      return { ok: true };
    }

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        name: dto.name,
        email: dto.email,
        phone: dto.phone ?? null,
        subject: dto.subject,
        body: dto.body,
        locale,
        ipHash,
        userAgent: userAgent?.slice(0, 255) ?? null,
      }),
    );

    const entity = { type: 'contact_messages', id: saved.id };

    await this.mailService.send({
      key: 'contact_ack',
      to: dto.email,
      // C16: nothing the sender typed is echoed back to the (unverified) address.
      vars: {},
      locale,
      entity,
    });

    const mailSettings = await this.mailSettingsRepo.findOne({ where: { id: '1' } });
    // Always call send() even when notify_email is unset — an empty `to` is
    // mail.service.ts's own signal to write a `skipped` row (with a reason)
    // instead of writing nothing at all, which would be indistinguishable
    // from "notified successfully, mail just hasn't gone out yet".
    await this.mailService.send({
      key: 'contact_notify',
      to: mailSettings?.notifyEmail ?? '',
      vars: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone ?? '',
        subject: contactSubjectLabel(dto.subject, 'ar'), // C23: a label, not the enum
        message: dto.body,
        link: frontendUrl(this.env, 'ar', `admin/messages/${saved.id}`),
      },
      locale: 'ar',
      entity,
    });

    return { ok: true };
  }

  /**
   * C27: double opt-in. The row is (re)created unconfirmed and a
   * `newsletter_confirm` mail with a signed link goes to the address; the
   * subscription only counts once `POST newsletter/confirm` verifies it.
   * The response is the same whatever the address's state, so it can't be
   * used to learn who is subscribed. An already-confirmed, active
   * subscription gets no second mail.
   */
  async subscribe(dto: NewsletterDto, ipHash: string | null, locale: Locale): Promise<{ ok: true }> {
    if (isHoneypotTripped(dto)) {
      return { ok: true };
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.newsletterRepo.findOne({ where: { email } });
    if (existing && existing.confirmedAt && !existing.unsubscribedAt) {
      return { ok: true };
    }
    const row = existing ?? this.newsletterRepo.create({ email, locale, ipHash });
    row.unsubscribedAt = null;
    row.confirmedAt = null;
    row.locale = locale;
    const saved = await this.newsletterRepo.save(row);

    const token = issueNewsletterToken(this.env.APP_ENCRYPTION_KEY, 'confirm', email);
    const link = frontendUrl(this.env, locale, `newsletter/confirm?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`);
    await this.mailService.send({
      key: 'newsletter_confirm',
      to: email,
      vars: { link },
      locale,
      entity: { type: 'newsletter_subscribers', id: saved.id },
    });
    return { ok: true };
  }

  /** C27: `POST newsletter/confirm` — the double opt-in link. */
  async confirmSubscription(email: string, token: string): Promise<{ ok: true }> {
    const normalized = email.trim().toLowerCase();
    if (!verifyNewsletterToken(this.env.APP_ENCRYPTION_KEY, 'confirm', normalized, token)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'This link is invalid or has expired');
    }
    await this.newsletterRepo
      .createQueryBuilder()
      .update(NewsletterSubscriber)
      .set({ confirmedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('email = :email', { email: normalized })
      .andWhere('confirmed_at IS NULL')
      .andWhere('unsubscribed_at IS NULL')
      .execute();
    return { ok: true };
  }

  /**
   * C27: `POST newsletter/unsubscribe` — from the signed link in a
   * newsletter mail (unsubscribeLink()). Same response whether or not the
   * address was subscribed.
   */
  async unsubscribe(email: string, token: string): Promise<{ ok: true }> {
    const normalized = email.trim().toLowerCase();
    if (!verifyNewsletterToken(this.env.APP_ENCRYPTION_KEY, 'unsubscribe', normalized, token)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'This link is invalid');
    }
    await this.newsletterRepo
      .createQueryBuilder()
      .update(NewsletterSubscriber)
      .set({ unsubscribedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('email = :email', { email: normalized })
      .andWhere('unsubscribed_at IS NULL')
      .execute();
    return { ok: true };
  }

  /** The unsubscribe link every newsletter mail must carry (C27). */
  unsubscribeLink(email: string, locale: Locale): string {
    const normalized = email.trim().toLowerCase();
    const token = issueNewsletterToken(this.env.APP_ENCRYPTION_KEY, 'unsubscribe', normalized);
    return frontendUrl(this.env, locale, `newsletter/unsubscribe?email=${encodeURIComponent(normalized)}&token=${encodeURIComponent(token)}`);
  }
}
