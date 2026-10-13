import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { Licence } from '../database/entities/licence.entity.js';
import { toPublicLicence, type PublicLicence } from './public-licence.js';

/**
 * GET /licences — the published licences, the primary first, then in the
 * editor's order. A handful of rows at most, so no paging. Cached under
 * `licences`, which every admin/licences write purges.
 */
@Controller('licences')
@SkipThrottle()
export class LicencesController {
  constructor(@InjectRepository(Licence) private readonly repo: Repository<Licence>) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('licences')
  @CacheKeyParams()
  async list(): Promise<PublicLicence[]> {
    const rows = await this.repo.find({
      where: { isPublished: true },
      relations: { asset: true },
      order: { isPrimary: 'DESC', sortOrder: 'ASC', id: 'ASC' },
    });
    return rows.map(toPublicLicence);
  }
}
