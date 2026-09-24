import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { WorkAreasController } from './work-areas.controller.js';
import { AdminWorkAreasController } from './admin-work-areas.controller.js';
import { AdminWorkAreaItemsController } from './admin-work-area-items.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([WorkArea, WorkAreaItem]), CacheModule],
  controllers: [WorkAreasController, AdminWorkAreasController, AdminWorkAreaItemsController],
})
export class WorkAreasModule {}
