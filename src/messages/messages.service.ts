import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CacheService } from '../cache/cache.service.js';
import { declarePurger } from '../cache/cache-tag-registry.js';
import { ContactMessage, type ContactMessageStatus } from '../database/entities/contact-message.entity.js';
import { MessageReply } from '../database/entities/message-reply.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { readPageLimit } from '../common/query/list-params.js';
import type { PagedResult } from '../common/crud/crud.factory.js';
import type { ConvertToTestimonialDto } from './dto/message.dto.js';

const EXCERPT_LENGTH = 140;

export interface MessageListItem {
  id: string;
  name: string;
  email: string;
  subject: ContactMessage['subject'];
  status: ContactMessageStatus;
  excerpt: string;
  createdAt: Date;
}

export interface MessageReplyView {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
}

export interface MessageDetail extends ContactMessage {
  replies: MessageReplyView[];
}

function excerptOf(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length > EXCERPT_LENGTH ? `${trimmed.slice(0, EXCERPT_LENGTH)}…` : trimmed;
}

/**
 * Hand-written (11-architecture.md §3 / project plan "Messages"), not
 * `CrudController`-shaped: `reply`, `convert-to-testimonial` and the
 * mark-read-on-view side effect on `GET :id` are all custom actions the
 * kernel has no hook for — the same reasoning as the reference's
 * `submissions.controller.ts`.
 */
@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(ContactMessage) private readonly messageRepo: Repository<ContactMessage>,
    @InjectRepository(MessageReply) private readonly replyRepo: Repository<MessageReply>,
    @InjectRepository(MailLog) private readonly mailLogRepo: Repository<MailLog>,
    @InjectRepository(Testimonial) private readonly testimonialRepo: Repository<Testimonial>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    private readonly cache: CacheService,
  ) {
    // A converted testimonial is created `pending` (never publicly visible
    // until an editor publishes it through admin/testimonials), so purging
    // here is a belt-and-braces move, not load-bearing — but
    // admin-testimonials.controller.ts already declares 'testimonials'/'home'
    // as purged tags, so this only needs to actually call purgeTag(), not
    // declare anything new. declarePurger() is idempotent (a Set) and cheap,
    // so it's still made explicit here for anyone reading this file alone.
    declarePurger('testimonials', 'home');
  }

  /** `GET /admin/overview`'s future "unread messages" sidebar badge (project plan §"Admin overview"). */
  async countUnread(): Promise<number> {
    return this.messageRepo.count({ where: { status: 'unread' } });
  }

  async list(query: Record<string, unknown>): Promise<PagedResult<MessageListItem> & { unreadCount: number }> {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: 20, maxLimit: 100 });
    const statusRaw = query.status;
    const status = typeof statusRaw === 'string' && ['unread', 'read', 'archived'].includes(statusRaw) ? (statusRaw as ContactMessageStatus) : undefined;

    const qb = this.messageRepo.createQueryBuilder('m').orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC');
    if (status) qb.andWhere('m.status = :status', { status });

    const unreadCount = await this.countUnread();

    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit, unreadCount };
    }

    qb.skip(offset).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    const data: MessageListItem[] = rows.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      subject: m.subject,
      status: m.status,
      excerpt: excerptOf(m.body),
      createdAt: m.createdAt,
    }));
    return { data, total, page, limit, unreadCount };
  }

  /**
   * Marks the message read as a side effect when it was `unread` — never
   * downgrades an `archived` message back to `read` (only an explicit
   * `PATCH :id` may change status once it's past `unread`). This is a `GET`,
   * so `AuditInterceptor` (write-methods only) never logs it — matching the
   * plan's "marks the message read" being described as a side effect of the
   * read itself, not a separate editorial action.
   */
  async findWithReplies(id: string): Promise<MessageDetail> {
    const message = await this.findOrNotFound(id);

    if (message.status === 'unread') {
      message.status = 'read';
      await this.messageRepo.save(message);
    }

    const replies = await this.replyRepo.find({ where: { messageId: id }, relations: { author: true }, order: { createdAt: 'ASC' } });
    return {
      ...message,
      replies: replies.map((r) => ({
        id: r.id,
        body: r.body,
        authorId: r.authorId,
        authorName: r.author?.name ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Sends the reply through the existing `MAIL_SERVICE` (`message_reply`
   * template, seeded in migrations/002_seed.sql with vars `["name","message"]`
   * — a usable match, no schema change needed), saves the `message_replies`
   * row, and links it to the `mail_log` row `send()` just wrote.
   * `MailServiceInterface.send()` returns `void` by design (trap 13: it never
   * lets a caller's flow depend on delivery) so the log row is looked up by
   * its own correlation key instead of a returned id — the same
   * `(entityType, entityId, templateKey)` triple `submissions.controller.ts`
   * (the reference) already queries by, ordered to the most recent row.
   */
  async reply(id: string, body: string, authorId: string): Promise<{ message: ContactMessage; reply: MessageReply }> {
    const message = await this.findOrNotFound(id);
    const wasUnread = message.status === 'unread';

    await this.mailService.send({
      key: 'message_reply',
      to: message.email,
      vars: { name: message.name, message: body },
      locale: message.locale,
      entity: { type: 'contact_messages', id: message.id },
    });

    const mailLog = await this.mailLogRepo.findOne({
      where: { entityType: 'contact_messages', entityId: message.id, templateKey: 'message_reply' },
      order: { id: 'DESC' },
    });

    const reply = await this.replyRepo.save(
      this.replyRepo.create({ messageId: id, authorId, body, mailLogId: mailLog?.id ?? null }),
    );

    if (wasUnread) {
      message.status = 'read';
      await this.messageRepo.save(message);
    }

    return { message, reply };
  }

  async setStatus(id: string, status: ContactMessageStatus): Promise<{ before: ContactMessageStatus; after: ContactMessage }> {
    const message = await this.findOrNotFound(id);
    const before = message.status;
    message.status = status;
    const after = await this.messageRepo.save(message);
    return { before, after };
  }

  /**
   * `authorName` defaults to the sender's own `name`; `authorDesc` (singular
   * in the plan/DTO — the message has no ar/en split to draw a second
   * description from) maps onto `authorDescAr` only, leaving `authorDescEn`
   * unset for an editor to add later, same as any other manually-created
   * testimonial.
   */
  async convertToTestimonial(id: string, dto: ConvertToTestimonialDto): Promise<Testimonial> {
    const message = await this.findOrNotFound(id);

    const testimonial = this.testimonialRepo.create({
      quoteAr: dto.quoteAr,
      quoteEn: dto.quoteEn ?? null,
      authorName: dto.authorName ?? message.name,
      authorDescAr: dto.authorDesc ?? null,
      authorDescEn: null,
      status: 'pending',
      source: 'contact_form',
      sourceMessageId: id,
    });
    const saved = await this.testimonialRepo.save(testimonial);
    this.cache.purgeTag('testimonials');
    this.cache.purgeTag('home');
    return saved;
  }

  /**
   * Cascades in the same transaction, following `submissions.controller.ts`'s
   * `remove()`: `message_replies` rows are `ON DELETE CASCADE` and
   * `testimonials.source_message_id` is `ON DELETE SET NULL` (both handled
   * by the FK itself — see migrations/001_schema.sql), but `mail_log` rows
   * correlate to this message only via the loose `(entity_type, entity_id)`
   * pair, not a real FK (`mail_log` intentionally outlives the row that
   * triggered it in every other flow) — so they're deleted explicitly here,
   * the same way the reference does for `contact_ack`, so a submitter's
   * message/phone/email don't linger in `mail_log.payload` past a deletion
   * request.
   */
  async remove(id: string): Promise<ContactMessage> {
    const message = await this.findOrNotFound(id);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(MailLog, { entityType: 'contact_messages', entityId: id });
      await manager.remove(message);
    });
    return message;
  }

  private async findOrNotFound(id: string): Promise<ContactMessage> {
    const message = await this.messageRepo.findOne({ where: { id } });
    if (!message) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    return message;
  }
}
