import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { readString } from '../common/query/list-params.js';
import { Partner } from '../database/entities/partner.entity.js';
import { toPublicPartner, type PublicPartner } from './public-partner.js';

@Controller('partners')
@SkipThrottle()
export class PartnersController {
  constructor(@InjectRepository(Partner) private readonly repo: Repository<Partner>) {}

  @ApiQuery({ name: 'category', required: false, type: String, enum: ['government', 'university', 'association', 'supporter'] })
  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('partners')
  @CacheKeyParams('category')
  async list(@Query() query: Record<string, unknown>): Promise<PublicPartner[]> {
    const category = readString(query, 'category');
    const partners = await this.repo.find({
      where: { isPublished: true, ...(category ? { category: category as Partner['category'] } : {}) },
      order: { sortOrder: 'ASC' },
      relations: { logoAsset: true },
    });
    return partners.map(toPublicPartner);
  }
}
