import { Controller, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Stat } from '../database/entities/stat.entity.js';
import { createStatSchema, updateStatSchema } from './dto/stat.dto.js';

@Controller('admin/stats')
@Roles('admin', 'editor')
class AdminStatsController extends CrudController<Stat>({
  path: 'admin/stats',
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
