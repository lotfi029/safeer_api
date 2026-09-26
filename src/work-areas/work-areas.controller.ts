import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { toPublicWorkArea, type PublicWorkArea } from './public-work-area.js';

@Controller('work-areas')
@SkipThrottle()
export class WorkAreasController {
  constructor(
    @InjectRepository(WorkArea) private readonly areaRepo: Repository<WorkArea>,
    @InjectRepository(WorkAreaItem) private readonly itemRepo: Repository<WorkAreaItem>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('work_areas')
  @CacheKeyParams()
  async list(): Promise<PublicWorkArea[]> {
    const areas = await this.areaRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC' } });
    if (areas.length === 0) return [];

    const items = await this.itemRepo.find({
      where: areas.map((a) => ({ workAreaId: a.id, isPublished: true })),
      order: { sortOrder: 'ASC' },
    });
    const itemsByArea = new Map<string, WorkAreaItem[]>();
    for (const item of items) {
      const bucket = itemsByArea.get(item.workAreaId);
      if (bucket) bucket.push(item);
      else itemsByArea.set(item.workAreaId, [item]);
    }
    return areas.map((area) => toPublicWorkArea(area, itemsByArea.get(area.id) ?? []));
  }
}
