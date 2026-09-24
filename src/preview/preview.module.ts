import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '../config/config.module.js';
import { Post } from '../database/entities/post.entity.js';
import { PreviewController } from './preview.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Post]), ConfigModule],
  controllers: [PreviewController],
})
export class PreviewModule {}
