import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { MetaController } from './meta.controller.js';

@Module({
  imports: [CacheModule],
  controllers: [MetaController],
})
export class MetaModule {}
