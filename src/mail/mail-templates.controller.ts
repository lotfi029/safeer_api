import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Permission } from '../auth/decorators/permission.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { MailTemplatesService } from './mail-templates.service.js';
import { UpdateMailTemplateDto, PreviewMailTemplateDto } from './dto/mail-template.dto.js';

@Controller('admin/mail/templates')
@ApiCookieAuth()
export class MailTemplatesController {
  constructor(private readonly templatesService: MailTemplatesService) {}

  @Permission('mail.view')
  @Get()
  list() {
    return this.templatesService.list();
  }

  @Permission('mail.view')
  @Get(':key')
  get(@Param('key') key: string) {
    return this.templatesService.getByKey(key);
  }

  @Permission('mail.view')
  @Get(':key/variables')
  async variables(@Param('key') key: string) {
    const template = await this.templatesService.getByKey(key);
    return { variables: template.variables };
  }

  @Permission('mail.manage')
  @Put(':key')
  async update(@Param('key') key: string, @Body() dto: UpdateMailTemplateDto, @Req() req: RequestContext) {
    const { before, after } = await this.templatesService.update(key, dto);
    req.auditContext = {
      action: 'update',
      entityType: 'mail_templates',
      entityId: after.id,
      entityLabel: after.nameAr,
      before,
      after,
    };
    return after;
  }

  @Permission('mail.manage')
  @Post(':key/preview')
  preview(@Param('key') key: string, @Body() dto: PreviewMailTemplateDto) {
    return this.templatesService.preview(key, dto.vars, dto.locale ?? 'ar');
  }
}
