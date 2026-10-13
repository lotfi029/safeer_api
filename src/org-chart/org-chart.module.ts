import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { OrgPosition } from '../database/entities/org-position.entity.js';
import { AdminOrgPositionsController } from './admin-org-positions.controller.js';
import { OrgChartController } from './org-chart.controller.js';

/** 023: the organisational structure — GET org-chart and admin/org-positions. */
@Module({
  imports: [TypeOrmModule.forFeature([OrgPosition, BoardMember]), CacheModule],
  controllers: [OrgChartController, AdminOrgPositionsController],
})
export class OrgChartModule {}
