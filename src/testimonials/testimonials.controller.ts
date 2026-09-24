import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { TestimonialTheme } from '../database/entities/testimonial-theme.entity.js';
import { toPublicTestimonial, toPublicTestimonialTheme, type PublicTestimonial, type PublicTestimonialTheme } from './public-testimonial.js';

export interface PublicTestimonialsResponse {
  featured: PublicTestimonial[];
  list: PublicTestimonial[];
  themes: PublicTestimonialTheme[];
}

@Controller('testimonials')
@SkipThrottle()
export class TestimonialsController {
  constructor(
    @InjectRepository(Testimonial) private readonly repo: Repository<Testimonial>,
    @InjectRepository(TestimonialTheme) private readonly themeRepo: Repository<TestimonialTheme>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('testimonials')
  @CacheKeyParams()
  async list(): Promise<PublicTestimonialsResponse> {
    const [published, themes] = await Promise.all([
      this.repo.find({ where: { status: 'published' }, order: { sortOrder: 'ASC' } }),
      this.themeRepo.find({ order: { sortOrder: 'ASC' } }),
    ]);
    const featured = published.filter((t) => t.isFeatured);
    return {
      featured: featured.map(toPublicTestimonial),
      list: published.map(toPublicTestimonial),
      themes: themes.map(toPublicTestimonialTheme),
    };
  }
}
