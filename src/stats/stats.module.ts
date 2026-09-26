import { Controller, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { Stat } from '../database/entities/stat.entity.js';
import { createStatSchema, updateStatSchema } from './dto/stat.dto.js';

@Controller('admin/stats')
@Area('content')
class AdminStatsController extends CrudController<Stat>({
  path: 'admin/stats',
  deleteArea: 'content',
  entity: Stat,
  createDto: createStatSchema,
  updateDto: updateStatSchema,
  publishable: true,
  sortable: true,
  searchable: ['labelAr', 'labelEn'],
  extraPurgeTags: ['home'],
  label: (s) => s.labelAr,
}) {}

/** No public `GET stats` route — impact numbers surface only through `GET /home`'s aggregate. */
@Module({
  imports: [TypeOrmModule.forFeature([Stat]), CacheModule],
  controllers: [AdminStatsController],
})
export class StatsModule {}
