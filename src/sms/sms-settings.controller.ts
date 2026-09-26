import { Body, Controller, Get, Put, Post, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Area } from '../auth/role-matrix.js';
import type { RequestContext } from '../common/request-context.js';
import { SmsSettingsService } from './sms-settings.service.js';
import { UpdateSmsSettingsDto, TestSmsDto } from './dto/sms-settings.dto.js';

/** Settings are association-wide, like mail_settings/site_settings — admin-only. */
@Controller('admin/sms/settings')
@Area('settings')
@ApiCookieAuth()
export class SmsSettingsController {
  constructor(private readonly settingsService: SmsSettingsService) {}

  @Get()
  get() {
    return this.settingsService.get();
  }

  @Put()
  async update(@Body() dto: UpdateSmsSettingsDto, @Req() req: RequestContext) {
    const { before, after } = await this.settingsService.update(dto, req.user!.id);
    req.auditContext = {
      action: 'update',
      entityType: 'sms_settings',
      entityId: after.id,
      entityLabel: 'SMS settings',
      before,
      after,
    };
    return after;
  }
}

@Controller('admin/sms')
@Area('settings')
@ApiCookieAuth()
export class SmsTestController {
  constructor(private readonly settingsService: SmsSettingsService) {}

  @Post('test')
  test(@Body() dto: TestSmsDto) {
    return this.settingsService.test(dto.to);
  }
}
