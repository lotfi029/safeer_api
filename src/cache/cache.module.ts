import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigModule } from '../config/config.module.js';
import { CacheService } from './cache.service.js';
import { CacheInterceptor } from './cache.interceptor.js';
import { CacheController } from './cache.controller.js';
import { CacheTagAssertion } from './cache-tag-assertion.js';

@Module({
  // DiscoveryModule: CacheTagAssertion walks every controller handler's
  // @CacheTags metadata at boot — see cache-tag-assertion.ts.
  imports: [ConfigModule, DiscoveryModule],
  controllers: [CacheController],
  providers: [CacheService, CacheInterceptor, CacheTagAssertion],
  // Re-export ConfigModule too: CacheInterceptor is instantiated per
  // consuming module (it's passed to `@UseInterceptors()` by class, not by
  // instance), so its own `@Inject(ENV)` constructor param has to resolve
  // against *that* module's visible providers — which, without this,
  // doesn't include ENV unless the consuming module also imports
  // ConfigModule directly (as library.module.ts does). Re-exporting it
  // here makes every CacheModule consumer work without that extra import.
  exports: [ConfigModule, CacheService, CacheInterceptor],
})
export class CacheModule {}
