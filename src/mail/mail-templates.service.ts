import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailTemplate } from '../database/entities/mail-template.entity.js';
import { MarkdownService } from '../common/markdown/markdown.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { extractVariables, substituteMarkdown, substitutePlain } from './render-template.js';
import type { UpdateMailTemplateDto } from './dto/mail-template.dto.js';
import type { Locale } from '../common/request-context.js';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class MailTemplatesService {
  constructor(
    @InjectRepository(MailTemplate) private readonly repo: Repository<MailTemplate>,
    private readonly markdown: MarkdownService,
  ) {}

  list(): Promise<MailTemplate[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async getByKey(key: string): Promise<MailTemplate> {
    const template = await this.repo.findOne({ where: { key } });
    if (!template) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Template not found');
    return template;
  }

  async update(key: string, dto: UpdateMailTemplateDto): Promise<{ before: MailTemplate; after: MailTemplate }> {
    const template = await this.getByKey(key);
    const before = { ...template };

    // Validate against the allow-list before writing anything (P10 step 3, FR-E-06).
    for (const text of [dto.subjectAr, dto.subjectEn, dto.bodyAr, dto.bodyEn]) {
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

  /** Used by MailService.send() — `null` when the template is disabled or missing, never throws (trap 13). */
  async render(key: string, vars: Record<string, string>, locale: Locale): Promise<RenderedMail | null> {
    const template = await this.repo.findOne({ where: { key } });
    if (!template || !template.isEnabled) return null;
    return this.renderFrom(template, vars, locale);
  }

  /** `POST /admin/mail/templates/:key/preview` — sample values fill any variable the caller didn't supply, nothing is sent. */
  async preview(key: string, vars: Record<string, string> | undefined, locale: Locale): Promise<RenderedMail> {
    const template = await this.getByKey(key);
    const sampleVars = Object.fromEntries(template.variables.map((name) => [name, vars?.[name] ?? `[${name}]`]));
    return this.renderFrom(template, sampleVars, locale);
  }

  private renderFrom(template: MailTemplate, vars: Record<string, string>, locale: Locale): RenderedMail {
    const subjectSource = (locale === 'en' && template.subjectEn) || template.subjectAr;
    const bodySource = (locale === 'en' && template.bodyEn) || template.bodyAr;
    return {
      subject: substitutePlain(subjectSource, vars),
      // M2/finding C: substitute into the Markdown source first, so
      // markdown.render() (DOMPurify) sanitises the actual final HTML
      // rather than running before the attacker-influenced bytes ever
      // arrive — see render-template.ts's substituteMarkdown for the full
      // reasoning, including why this also fixes a dead link in three of
      // the five seeded templates.
      html: this.markdown.render(substituteMarkdown(bodySource, vars)),
      text: substitutePlain(bodySource, vars),
    };
  }
}
