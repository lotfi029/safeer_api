import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { TestimonialTheme } from '../database/entities/testimonial-theme.entity.js';
import { createTestimonialThemeSchema, updateTestimonialThemeSchema } from './dto/testimonial.dto.js';

/** No `isPublished` column on `testimonial_themes` — `publishable` is intentionally omitted. */
@Controller('admin/testimonial-themes')
@Roles('admin', 'support')
export class AdminTestimonialThemesController extends CrudController<TestimonialTheme>({
  path: 'admin/testimonial-themes',
  entity: TestimonialTheme,
  createDto: createTestimonialThemeSchema,
  updateDto: updateTestimonialThemeSchema,
  sortable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['testimonials', 'home'],
  label: (t) => t.titleAr,
}) {}
