import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactMessage } from '../database/entities/contact-message.entity.js';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { NewsletterSubscriber } from '../database/entities/newsletter-subscriber.entity.js';
import { MailModule } from '../mail/mail.module.js';
import { ConfigModule } from '../config/config.module.js';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';
import { AdminNewsletterController } from './admin-newsletter.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([ContactMessage, MailSettings, NewsletterSubscriber]), MailModule, ConfigModule],
  controllers: [ContactController, AdminNewsletterController],
  providers: [ContactService],
})
export class ContactModule {}
