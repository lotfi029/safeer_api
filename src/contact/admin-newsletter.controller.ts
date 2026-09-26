import { Controller, Delete, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { readPageLimit, readString } from '../common/query/list-params.js';
import { toCsvWithBom } from '../common/csv.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import type { PagedResult } from '../common/crud/crud.factory.js';
import { NewsletterSubscriber } from '../database/entities/newsletter-subscriber.entity.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Hand-written rather than `CrudController<NewsletterSubscriber>` — there is
 * no create/update route (subscribers only ever come from the public
 * `POST /newsletter`), and its one filter (`status`) reads a derived
 * "is `unsubscribed_at` set" condition the kernel's automatic column filter
 * can't express.
 */
@Controller('admin/newsletter')
@Roles('admin', 'support')
@ApiCookieAuth()
export class AdminNewsletterController {
  constructor(@InjectRepository(NewsletterSubscriber) private readonly repo: Repository<NewsletterSubscriber>) {}

  @ApiQuery({ name: 'status', required: false, enum: ['subscribed', 'pending', 'unsubscribed'] })
  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<PagedResult<NewsletterSubscriber>> {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    const qb = this.buildFilteredQuery(readString(query, 'status'));

    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  @ApiQuery({ name: 'status', required: false, enum: ['subscribed', 'pending', 'unsubscribed'] })
  @Get('export.csv')
  async exportCsv(@Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const rows = await this.buildFilteredQuery(readString(query, 'status')).getMany();
    const csv = toCsvWithBom(rows, [
      { header: 'Email', value: (r) => r.email },
      { header: 'Locale', value: (r) => r.locale },
      { header: 'Subscribed at', value: (r) => r.createdAt.toISOString() },
      { header: 'Confirmed at', value: (r) => r.confirmedAt?.toISOString() ?? '' },
      { header: 'Unsubscribed at', value: (r) => r.unsubscribedAt?.toISOString() ?? '' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="newsletter-subscribers.csv"');
    res.send(csv);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');

    await this.repo.remove(entity);
    req.auditContext = {
      action: 'delete',
      entityType: 'newsletter_subscribers',
      entityId: id,
      entityLabel: entity.email,
      before: entity,
    };
    return { deleted: true };
  }

  private buildFilteredQuery(status: string | undefined) {
    const qb = this.repo.createQueryBuilder('n').orderBy('n.createdAt', 'DESC');
    // C27: `subscribed` means confirmed (double opt-in) and not unsubscribed;
    // `pending` is signed up but not yet confirmed.
    if (status === 'subscribed') qb.andWhere('n.unsubscribedAt IS NULL').andWhere('n.confirmedAt IS NOT NULL');
    else if (status === 'pending') qb.andWhere('n.unsubscribedAt IS NULL').andWhere('n.confirmedAt IS NULL');
    else if (status === 'unsubscribed') qb.andWhere('n.unsubscribedAt IS NOT NULL');
    return qb;
  }
}
