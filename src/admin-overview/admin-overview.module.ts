import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { MessagesModule } from '../messages/messages.module.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';

/**
 * The staff dashboard aggregate (`GET admin/overview`). `MessagesModule` is
 * imported (not just its entities) so `AdminOverviewService` reuses
 * `MessagesService.countUnread()` rather than duplicating that query.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, Partner, Post, Page]), MessagesModule],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
})
export class AdminOverviewModule {}
