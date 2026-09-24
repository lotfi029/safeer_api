import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { SiteController } from './site.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([SiteSettings, Page]), CacheModule],
  controllers: [SiteController],
})
export class SiteModule {}
