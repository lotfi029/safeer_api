import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SmsLog } from '../database/entities/sms-log.entity.js';
import { SmsSettings } from '../database/entities/sms-settings.entity.js';
import { SmsTemplate } from '../database/entities/sms-template.entity.js';
import { ConfigModule } from '../config/config.module.js';
import { SMS_SERVICE } from './sms.service.interface.js';
import { SmsService } from './sms.service.js';
import { SmsTransportService } from './sms-transport.service.js';
import { SmsTemplatesService } from './sms-templates.service.js';
import { SmsSettingsService } from './sms-settings.service.js';
import { SmsSettingsController, SmsTestController } from './sms-settings.controller.js';
import { SmsTemplatesController } from './sms-templates.controller.js';
import { SmsLogController } from './sms-log.controller.js';

/** Mirrors mail.module.ts's shape exactly — see sms.service.ts for the one deliberate behavioural difference (no retry queue). */
@Module({
  imports: [TypeOrmModule.forFeature([SmsLog, SmsSettings, SmsTemplate]), ConfigModule],
  controllers: [SmsSettingsController, SmsTestController, SmsTemplatesController, SmsLogController],
  providers: [
    SmsTransportService,
    SmsTemplatesService,
    SmsSettingsService,
    SmsService,
    { provide: SMS_SERVICE, useExisting: SmsService },
  ],
  exports: [SMS_SERVICE],
})
export class SmsModule {}
