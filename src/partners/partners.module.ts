import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Partner } from '../database/entities/partner.entity.js';
import { PartnersController } from './partners.controller.js';
import { AdminPartnersController } from './admin-partners.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Partner]), CacheModule],
  controllers: [PartnersController, AdminPartnersController],
})
export class PartnersModule {}
