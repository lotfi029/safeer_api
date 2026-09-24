import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { SiteSettingsController } from './site-settings.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([SiteSettings]), CacheModule],
  controllers: [SiteSettingsController],
})
export class SiteSettingsModule {}
