import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactMessage } from '../database/entities/contact-message.entity.js';
import { MessageReply } from '../database/entities/message-reply.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { MailModule } from '../mail/mail.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { AdminMessagesController } from './admin-messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ContactMessage, MessageReply, MailLog, Testimonial]), MailModule, CacheModule],
  controllers: [AdminMessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
