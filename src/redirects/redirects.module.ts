import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Redirect } from '../database/entities/redirect.entity.js';
import { RedirectsController } from './redirects.controller.js';
import { RedirectsPublicController } from './redirects-public.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Redirect]), CacheModule],
  controllers: [RedirectsController, RedirectsPublicController],
})
export class RedirectsModule {}
