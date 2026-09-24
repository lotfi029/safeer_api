import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { Stat } from '../database/entities/stat.entity.js';
import { AboutItem } from '../database/entities/about-item.entity.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { HomeService } from './home.service.js';
import { HomeController } from './home.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([SiteSettings, Stat, AboutItem, WorkArea, WorkAreaItem, Post, Testimonial, Partner, PageSection]),
    CacheModule,
  ],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
