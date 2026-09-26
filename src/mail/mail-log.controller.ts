import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { Area } from '../auth/role-matrix.js';
import { readPageLimit, readString } from '../common/query/list-params.js';
import type { RequestContext } from '../common/request-context.js';
import { MailService } from './mail.service.js';
import { toPublicMailLog, type PublicMailLog } from './public-mail-log.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('admin/mail/log')
@Area('settings')
@ApiCookieAuth()
export class MailLogController {
  constructor(
    @InjectRepository(MailLog) private readonly repo: Repository<MailLog>,
    private readonly mailService: MailService,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'template', required: false, type: String })
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    // H1: clamp the computed offset, not just the page number.
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

    const qb = this.repo.createQueryBuilder('m').orderBy('m.createdAt', 'DESC');
    // H2: readString guards status/template the same way as every other
    // list route — a repeated key must not reach mysql2 as a non-string
    // bind parameter.
    const status = readString(query, 'status');
    const template = readString(query, 'template');
    if (status) qb.andWhere('m.status = :status', { status });
    if (template) qb.andWhere('m.templateKey = :template', { template });

    // 30-backend-finishing-prompt.md §2.5 (task 5): report the real
    // (filtered) total even past the last real page — see
    // audit.controller.ts's identical comment. `mail_log` in particular has
    // no NFR-12-style ceiling at all (only a 90-day retention sweep), so an
    // admin paging through it is exactly the caller most likely to run past
    // whatever page count they expected.
    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);

    const [data, total] = await qb.getManyAndCount();
    // H3: without this, any admin browsing the mail log saw every other
    // user's in-flight reset/invite link in `payload` — see
    // public-mail-log.ts.
    return { data: data.map(toPublicMailLog), total, page, limit };
  }

  @Post(':id/retry')
  async retry(@Param('id') id: string, @Req() req: RequestContext): Promise<PublicMailLog> {
    const row = await this.mailService.retryNow(id);
    const publicRow = toPublicMailLog(row);
    req.auditContext = {
      action: 'update',
      entityType: 'mail_log',
      entityId: id,
      entityLabel: row.subject,
      // H3: the raw entity here — including `payload` — went into
      // `audit_log.diff`, which is append-only with no retention sweep and
      // no DELETE grant. The projection makes what lands in the audit log
      // the same shape the API ever returns to a client.
      after: publicRow,
    };
    return publicRow;
  }
}
