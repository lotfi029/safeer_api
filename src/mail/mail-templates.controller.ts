import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { MailTemplatesService } from './mail-templates.service.js';
import { UpdateMailTemplateDto, PreviewMailTemplateDto } from './dto/mail-template.dto.js';

@Controller('admin/mail/templates')
@Roles('admin')
@ApiCookieAuth()
export class MailTemplatesController {
  constructor(private readonly templatesService: MailTemplatesService) {}

  @Get()
  list() {
    return this.templatesService.list();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    return this.templatesService.getByKey(key);
  }

  @Get(':key/variables')
  async variables(@Param('key') key: string) {
    const template = await this.templatesService.getByKey(key);
    return { variables: template.variables };
  }

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

  @Post(':key/preview')
  preview(@Param('key') key: string, @Body() dto: PreviewMailTemplateDto) {
    return this.templatesService.preview(key, dto.vars, dto.locale ?? 'ar');
  }
}
