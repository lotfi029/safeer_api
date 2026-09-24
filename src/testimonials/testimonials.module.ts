import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { TestimonialTheme } from '../database/entities/testimonial-theme.entity.js';
import { TestimonialsController } from './testimonials.controller.js';
import { AdminTestimonialsController } from './admin-testimonials.controller.js';
import { AdminTestimonialThemesController } from './admin-testimonial-themes.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Testimonial, TestimonialTheme]), CacheModule],
  controllers: [TestimonialsController, AdminTestimonialsController, AdminTestimonialThemesController],
})
export class TestimonialsModule {}
