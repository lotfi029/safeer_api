import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { HomeService, type PublicHome } from './home.service.js';

@Controller('home')
@SkipThrottle()
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('home')
  // This route reads no query params at all — declared explicitly so a
  // stray query string can never widen its cache key.
  @CacheKeyParams()
  get(): Promise<PublicHome> {
    return this.homeService.getHome();
  }
}
