import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Licence } from '../database/entities/licence.entity.js';
import { AdminLicencesController } from './admin-licences.controller.js';
import { LicencesController } from './licences.controller.js';

/** 022: the association's licences — GET licences and admin/licences. */
@Module({
  imports: [TypeOrmModule.forFeature([Licence]), CacheModule],
  controllers: [LicencesController, AdminLicencesController],
})
export class LicencesModule {}
