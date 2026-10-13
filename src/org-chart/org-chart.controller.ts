import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { OrgPosition } from '../database/entities/org-position.entity.js';
import { buildOrgForest, type PublicOrgNode } from './public-org-chart.js';

/**
 * GET /org-chart — the organisational structure as a forest of published
 * positions, each with the names of the published members holding it (when
 * the position shows holders). Cached under `org_chart`, which every
 * admin/org-positions write and every admin/board write purges.
 */
@Controller('org-chart')
@SkipThrottle()
export class OrgChartController {
  constructor(
    @InjectRepository(OrgPosition) private readonly positions: Repository<OrgPosition>,
    @InjectRepository(BoardMember) private readonly members: Repository<BoardMember>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('org_chart')
  @CacheKeyParams()
  async chart(): Promise<PublicOrgNode[]> {
    const [positions, members] = await Promise.all([
      this.positions.find({ where: { isPublished: true }, order: { sortOrder: 'ASC', id: 'ASC' } }),
      this.members.find({ where: { isPublished: true, orgPositionId: Not(IsNull()) }, order: { sortOrder: 'ASC', id: 'ASC' } }),
    ]);
    return buildOrgForest(positions, members);
  }
}
