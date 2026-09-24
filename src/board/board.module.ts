import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { BoardController } from './board.controller.js';
import { AdminBoardController } from './admin-board.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([BoardMember]), CacheModule],
  controllers: [BoardController, AdminBoardController],
})
export class BoardModule {}
