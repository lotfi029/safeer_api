import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Area } from '../auth/role-matrix.js';
import type { RequestContext } from '../common/request-context.js';
import { SmsTemplatesService } from './sms-templates.service.js';
import { UpdateSmsTemplateDto, PreviewSmsTemplateDto } from './dto/sms-template.dto.js';

@Controller('admin/sms/templates')
@Area('settings')
@ApiCookieAuth()
export class SmsTemplatesController {
  constructor(private readonly templatesService: SmsTemplatesService) {}

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
  async update(@Param('key') key: string, @Body() dto: UpdateSmsTemplateDto, @Req() req: RequestContext) {
    const { before, after } = await this.templatesService.update(key, dto);
    req.auditContext = {
      action: 'update',
      entityType: 'sms_templates',
      entityId: after.id,
      entityLabel: after.nameAr,
      before,
      after,
    };
    return after;
  }

  @Post(':key/preview')
  async preview(@Param('key') key: string, @Body() dto: PreviewSmsTemplateDto) {
    const message = await this.templatesService.preview(key, dto.vars, dto.locale ?? 'ar');
    return { message };
  }
}
