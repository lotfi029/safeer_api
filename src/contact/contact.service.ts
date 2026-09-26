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
        subject: dto.subject,
        message: dto.body,
        link: frontendUrl(this.env, 'ar', `admin/messages/${saved.id}`),
      },
      locale: 'ar',
      entity,
    });

    return { ok: true };
  }

  /**
   * Idempotent on email: a repeat subscription (or a re-subscribe after
   * unsubscribing) simply un-sets `unsubscribed_at` on the existing row
   * rather than erroring on the unique constraint.
   */
  async subscribe(dto: NewsletterDto, ipHash: string | null, locale: Locale): Promise<{ ok: true }> {
    if (isHoneypotTripped(dto)) {
      return { ok: true };
    }

    const existing = await this.newsletterRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      if (existing.unsubscribedAt !== null) {
        existing.unsubscribedAt = null;
        await this.newsletterRepo.save(existing);
      }
      return { ok: true };
    }

    await this.newsletterRepo.save(this.newsletterRepo.create({ email: dto.email, locale, ipHash }));
    return { ok: true };
  }
}
