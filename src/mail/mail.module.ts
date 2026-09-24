import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { MailTemplate } from '../database/entities/mail-template.entity.js';
import { MarkdownModule } from '../common/markdown/markdown.module.js';
import { ConfigModule } from '../config/config.module.js';
import { MAIL_SERVICE } from './mail.service.interface.js';
import { MailService } from './mail.service.js';
import { MailTransportService } from './mail-transport.service.js';
import { MailTemplatesService } from './mail-templates.service.js';
import { MailSettingsService } from './mail-settings.service.js';
import { MailSettingsController, MailTestController } from './mail-settings.controller.js';
import { MailTemplatesController } from './mail-templates.controller.js';
import { MailLogController } from './mail-log.controller.js';

/**
 * P10 replaces the P6 no-op `MAIL_SERVICE` binding with the real,
 * queue-backed implementation — everything that already depends on
 * `MAIL_SERVICE` (AuthModule's invite/reset flows) picks it up with no
 * other change, exactly as planned.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MailLog, MailSettings, MailTemplate]), MarkdownModule, ConfigModule],
  controllers: [MailSettingsController, MailTestController, MailTemplatesController, MailLogController],
  providers: [
    MailTransportService,
    MailTemplatesService,
    MailSettingsService,
    MailService,
    { provide: MAIL_SERVICE, useExisting: MailService },
  ],
  exports: [MAIL_SERVICE],
})
export class MailModule {}
