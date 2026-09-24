import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsTemplate } from '../database/entities/sms-template.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { extractVariables, substitutePlain } from '../mail/render-template.js';
import type { UpdateSmsTemplateDto } from './dto/sms-template.dto.js';
import type { Locale } from '../common/request-context.js';

/**
 * Mirrors MailTemplatesService (src/mail/mail-templates.service.ts), reusing
 * its `substitutePlain`/`extractVariables` rather than duplicating them —
 * SMS has no HTML, so there is no `substituteMarkdown` counterpart and no
 * markdown-escaping path to reuse.
 */
@Injectable()
export class SmsTemplatesService {
  constructor(@InjectRepository(SmsTemplate) private readonly repo: Repository<SmsTemplate>) {}

  list(): Promise<SmsTemplate[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async getByKey(key: string): Promise<SmsTemplate> {
    const template = await this.repo.findOne({ where: { key } });
    if (!template) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Template not found');
    return template;
  }

  async update(key: string, dto: UpdateSmsTemplateDto): Promise<{ before: SmsTemplate; after: SmsTemplate }> {
    const template = await this.getByKey(key);
    const before = { ...template };

    for (const text of [dto.bodyAr, dto.bodyEn]) {
      if (!text) continue;
      for (const name of extractVariables(text)) {
        if (!template.variables.includes(name)) {
          throw new ProblemException(400, ErrorCode.UNKNOWN_VARIABLE, `Unknown template variable: {{${name}}}`, { variable: name });
        }
      }
    }

    Object.assign(template, dto);
    const saved = await this.repo.save(template);
    return { before, after: saved };
  }

  /** Used by SmsService.send() — `null` when the template is disabled or missing, never throws (mirrors mail's trap 13). */
  async render(key: string, vars: Record<string, string>, locale: Locale): Promise<string | null> {
    const template = await this.repo.findOne({ where: { key } });
    if (!template || !template.isEnabled) return null;
    return this.renderFrom(template, vars, locale);
  }

  /** `POST /admin/sms/templates/:key/preview` — sample values fill any variable the caller didn't supply, nothing is sent. */
  async preview(key: string, vars: Record<string, string> | undefined, locale: Locale): Promise<string> {
    const template = await this.getByKey(key);
    const sampleVars = Object.fromEntries(template.variables.map((name) => [name, vars?.[name] ?? `[${name}]`]));
    return this.renderFrom(template, sampleVars, locale);
  }

  private renderFrom(template: SmsTemplate, vars: Record<string, string>, locale: Locale): string {
    const bodySource = (locale === 'en' && template.bodyEn) || template.bodyAr;
    return substitutePlain(bodySource, vars);
  }
}
