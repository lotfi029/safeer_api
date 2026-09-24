import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { Counter } from '../database/entities/counter.entity.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { MailModule } from '../mail/mail.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigModule } from '../config/config.module.js';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';

/**
 * The public "start an application" entry point (13-backend-build-plan.md
 * phase 6 / the plan's "Apply flow and portal" section). Everything past
 * step 1 — autosave, submit, documents, OTP sign-in — lives in
 * `PortalModule`, which sits behind `@ApplicantRoute()` and the session
 * this module mints.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Application, ApplicationEvent, Counter, SiteSettings]), MailModule, AuthModule, ConfigModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
