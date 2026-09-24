import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsLog } from '../database/entities/sms-log.entity.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { readPageLimit, readString } from '../common/query/list-params.js';
import { toPublicSmsLog } from './public-sms-log.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('admin/sms/log')
@Roles('admin')
@ApiCookieAuth()
export class SmsLogController {
  constructor(@InjectRepository(SmsLog) private readonly repo: Repository<SmsLog>) {}

  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'template', required: false, type: String })
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

    const qb = this.repo.createQueryBuilder('m').orderBy('m.createdAt', 'DESC');
    const status = readString(query, 'status');
    const template = readString(query, 'template');
    if (status) qb.andWhere('m.status = :status', { status });
    if (template) qb.andWhere('m.templateKey = :template', { template });

    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data: data.map(toPublicSmsLog), total, page, limit };
  }
}
