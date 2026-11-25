import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { Permission } from '../auth/decorators/permission.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import type { ContactMessage } from '../database/entities/contact-message.entity.js';
import type { Testimonial } from '../database/entities/testimonial.entity.js';
import { ConvertToTestimonialDto, ReplyMessageDto, SetMessageStatusDto } from './dto/message.dto.js';
import { MessagesService, type MessageDetail, type MessageListItem } from './messages.service.js';
import type { PagedResult } from '../common/crud/crud.factory.js';

/**
 * `admin/messages` — the contact inbox (project plan "Messages", hand-written
 * since `reply`/`convert-to-testimonial`/mark-read-on-view aren't
 * `CrudController`-shaped). Gated on the `messages` module (PERM-3):
 * the seeded `support` role holds view/manage; `messages.delete` stays
 * admin-only in the seeded roles.
 */
@Controller('admin/messages')
@ApiCookieAuth()
export class AdminMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @ApiQuery({ name: 'status', required: false, enum: ['unread', 'read', 'archived'] })
  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Permission('messages.view')
  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<PagedResult<MessageListItem> & { unreadCount: number }> {
    return this.messages.list(query);
  }

  @Permission('messages.view')
  @Get(':id')
  async get(@Param('id') id: string): Promise<MessageDetail> {
    return this.messages.findWithReplies(id);
  }

  /**
   * Audit snapshot excludes the reply body and the message's personal
   * contact info (email/phone/name), mirroring `submissions.controller.ts`'s
   * privacy pattern for a write against `contact_messages` — this is a
   * "wrote a reply" action, recorded against the new `message_replies` row
   * (a `create`), not the message it replied to.
   */
  @Permission('messages.manage')
  @Post(':id/reply')
  async reply(@Param('id') id: string, @Body() dto: ReplyMessageDto, @Req() req: RequestContext): Promise<{ message: ContactMessage; reply: unknown }> {
    const { message, reply } = await this.messages.reply(id, dto.body, req.user!.id);
    req.auditContext = {
      action: 'create',
      entityType: 'message_replies',
      entityId: reply.id,
      entityLabel: `reply to message #${id}`,
      after: { id: reply.id, messageId: id, authorId: reply.authorId, mailLogId: reply.mailLogId },
    };
    return { message, reply };
  }

  @Permission('messages.manage')
  @Patch(':id')
  async setStatus(@Param('id') id: string, @Body() dto: SetMessageStatusDto, @Req() req: RequestContext): Promise<ContactMessage> {
    const { before, after } = await this.messages.setStatus(id, dto.status);
    req.auditContext = {
      action: 'update',
      entityType: 'contact_messages',
      entityId: id,
      entityLabel: `contact message #${id}`,
      before: { status: before },
      after: { status: after.status },
    };
    return after;
  }

  // Writes a testimonial too, so it needs that module's manage as well.
  @Permission('messages.manage', 'testimonials.manage')
  @Post(':id/convert-to-testimonial')
  async convertToTestimonial(@Param('id') id: string, @Body() dto: ConvertToTestimonialDto, @Req() req: RequestContext): Promise<Testimonial> {
    const saved = await this.messages.convertToTestimonial(id, dto);
    req.auditContext = {
      action: 'create',
      entityType: 'testimonials',
      entityId: saved.id,
      entityLabel: saved.authorName,
      after: saved,
    };
    return saved;
  }

  /**
   * `messages.delete` (admin-only in the seeded roles). Audit snapshot
   * carries no personal data — `entityLabel` is a content-free id string and
   * `before` only records `status`/`createdAt`, the same redaction
   * `submissions.controller.ts`'s `remove()` applies for the identical PDPL
   * reason: `audit_log` is append-only with no DELETE grant, so anything
   * recorded here outlives the deletion it's evidence of.
   */
  @Permission('messages.delete')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const message = await this.messages.remove(id);
    req.auditContext = {
      action: 'delete',
      entityType: 'contact_messages',
      entityId: id,
      entityLabel: `contact message #${id}`,
      before: { id: message.id, status: message.status, createdAt: message.createdAt },
    };
    return { deleted: true };
  }
}
