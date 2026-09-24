import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationDocument } from '../database/entities/application-document.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { ApplicantOtp } from '../database/entities/applicant-otp.entity.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { MailModule } from '../mail/mail.module.js';
import { SmsModule } from '../sms/sms.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigModule } from '../config/config.module.js';
import { PortalController } from './portal.controller.js';
import { PortalApplicationController } from './portal-application.controller.js';
import { PortalDocumentsController } from './portal-documents.controller.js';
import { PortalInterviewController } from './portal-interview.controller.js';
import { PortalAuthController } from './portal-auth.controller.js';
import { PortalApplicationService } from './portal-application.service.js';
import { PortalOtpService } from './portal-otp.service.js';
import { PortalDocumentsService } from './portal-documents.service.js';
import { PortalInterviewService } from './portal-interview.service.js';

/**
 * Everything behind `@ApplicantRoute()` (13-backend-build-plan.md phase 6 /
 * the plan's "Apply flow and portal" section), plus the two OTP routes that
 * are public but operate on an existing application resolved by
 * reference-or-email rather than `req.applicant`. `ApplicationsModule`
 * (the public "start an application" step) is the only other place that
 * mints an `applicant_sessions` row — both import `AuthModule` for
 * `ApplicantSessionService` so the two never drift on cookie shape.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Application, ApplicationDocument, ApplicationEvent, ApplicantOtp, InterviewSlot]),
    MailModule,
    SmsModule,
    StorageModule,
    AuthModule,
    ConfigModule,
  ],
  controllers: [PortalController, PortalApplicationController, PortalDocumentsController, PortalInterviewController, PortalAuthController],
  providers: [PortalApplicationService, PortalOtpService, PortalDocumentsService, PortalInterviewService],
})
export class PortalModule {}
