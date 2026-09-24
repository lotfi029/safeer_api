import { Body, Controller, Get, Put, Post, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { MailSettingsService } from './mail-settings.service.js';
import { UpdateMailSettingsDto, TestMailDto } from './dto/mail-settings.dto.js';

/** Settings are association-wide, like site_settings — admin-only. */
@Controller('admin/mail/settings')
@Roles('admin')
@ApiCookieAuth()
export class MailSettingsController {
  constructor(private readonly settingsService: MailSettingsService) {}

  @Get()
  get() {
    return this.settingsService.get();
  }

  @Put()
  async update(@Body() dto: UpdateMailSettingsDto, @Req() req: RequestContext) {
    const { before, after } = await this.settingsService.update(dto, req.user!.id);
    req.auditContext = {
      action: 'update',
      entityType: 'mail_settings',
      entityId: after.id,
      entityLabel: 'Mail settings',
      before,
      after,
    };
    return after;
  }
}

@Controller('admin/mail')
@Roles('admin')
@ApiCookieAuth()
export class MailTestController {
  constructor(private readonly settingsService: MailSettingsService) {}

  @Post('test')
  test(@Body() dto: TestMailDto) {
    return this.settingsService.test(dto.to);
  }
}
