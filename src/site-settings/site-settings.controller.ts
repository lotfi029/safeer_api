import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheService } from '../cache/cache.service.js';
import { declarePurger } from '../cache/cache-tag-registry.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { UpdateSiteSettingsDto } from './dto/site-settings.dto.js';

const SINGLETON_ID = '1';

/**
 * Singleton — `GET`/`PUT` only, no list, no delete, mirroring african_api's
 * site-settings module. `002_seed.sql` inserts the one row; this service
 * only ever UPDATEs it, never INSERTs. Settings are association-wide, so
 * admin-only (`@Roles('admin')`), unlike the content collections editors
 * can also manage (Safeer infra change §1's permission matrix).
 *
 * `declarePurger('site_settings', 'home')` is registered here even though
 * no public route serves either tag yet — the `home`/`site` aggregates land
 * in phase 4. `cache-tag-assertion.ts` only fails boot in the other
 * direction (a tag *served* by a route with no purger); a purger with no
 * server is merely logged at debug, so this is harmless ahead of time and
 * saves having to remember to add it once those routes exist.
 */
@Controller('admin/settings')
@Roles('admin')
@ApiCookieAuth()
export class SiteSettingsController {
  constructor(
    @InjectRepository(SiteSettings) private readonly repo: Repository<SiteSettings>,
    private readonly cache: CacheService,
  ) {
    declarePurger('site_settings', 'home');
  }

  @Get()
  async get(): Promise<SiteSettings> {
    return this.findSingleton();
  }

  @Put()
  async update(@Body() dto: UpdateSiteSettingsDto, @Req() req: RequestContext): Promise<SiteSettings> {
    const entity = await this.findSingleton();
    const before = { ...entity };

    Object.assign(entity, dto);
    entity.updatedBy = req.user!.id;
    const saved = await this.repo.save(entity); // save() on an existing PK issues UPDATE, never INSERT.

    this.cache.purgeTag('site_settings');
    this.cache.purgeTag('home');
    req.auditContext = {
      action: 'update',
      entityType: 'site_settings',
      entityId: saved.id,
      entityLabel: 'site settings',
      before,
      after: saved,
    };
    return saved;
  }

  private async findSingleton(): Promise<SiteSettings> {
    const row = await this.repo.findOne({ where: { id: SINGLETON_ID } });
    if (!row) {
      // 002_seed.sql always inserts this row; reaching here means the seed
      // was never applied — a genuine 500, not a client error.
      throw new Error('site_settings singleton row is missing — has 002_seed.sql been applied?');
    }
    return row;
  }
}
