import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAsset } from '../database/entities/media-asset.entity.js';
import { MediaVariant } from '../database/entities/media-variant.entity.js';
import { ConfigModule } from '../config/config.module.js';
import { MediaService } from './media.service.js';
import { MediaController } from './media.controller.js';
import { CacheModule } from '../cache/cache.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([MediaAsset, MediaVariant]), ConfigModule, CacheModule, StorageModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
