import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationDocument } from '../database/entities/application-document.entity.js';
import { ApplicationNote } from '../database/entities/application-note.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { User } from '../database/entities/user.entity.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { MailModule } from '../mail/mail.module.js';
import { SmsModule } from '../sms/sms.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { ConfigModule } from '../config/config.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { AdminApplicationsController } from './admin-applications.controller.js';
import { AdminApplicationsService } from './admin-applications.service.js';
import { AdminInterviewSlotsController } from './admin-interview-slots.controller.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';

/**
 * Phase 7 — the admin/reviewer half of the scholarship pipeline: listing,
 * counts, CSV export, single-application review (status transitions,
 * reviewer assignment), document accept/reject, request-documents, internal
 * notes, bulk actions, interview-slot management, and the staff overview
 * aggregate. `MessagesModule` is imported (not just its entities) so
 * `AdminOverviewService` can reuse `MessagesService.countUnread()` rather
 * than duplicating that query.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      ApplicationDocument,
      ApplicationNote,
      ApplicationEvent,
      InterviewSlot,
      User,
      SiteSettings,
      AuditLog,
      Partner,
      Post,
      Page,
    ]),
    MailModule,
    SmsModule,
    StorageModule,
    CacheModule,
    ConfigModule,
    MessagesModule,
  ],
  controllers: [AdminApplicationsController, AdminInterviewSlotsController, AdminOverviewController],
  providers: [AdminApplicationsService, AdminOverviewService],
})
export class AdminApplicationsModule {}
