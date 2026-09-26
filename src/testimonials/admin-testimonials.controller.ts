import { Body, Controller, Param, Patch, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import type { RequestContext } from '../common/request-context.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import {
  createTestimonialSchema,
  updateTestimonialSchema,
  SetTestimonialStatusDto,
  SetTestimonialFeatureDto,
} from './dto/testimonial.dto.js';

const BaseAdminTestimonialsController = CrudController<Testimonial>({
  path: 'admin/testimonials',
  deleteArea: 'inbox',
  entity: Testimonial,
  createDto: createTestimonialSchema,
  updateDto: updateTestimonialSchema,
  // No `isPublished` column — moderation is the `status` enum instead
  // (pending/published/hidden), handled by the two custom routes below, not
  // the kernel's `publishable`/`PATCH :id/publish`.
  sortable: true,
  searchable: ['authorName', 'quoteAr', 'quoteEn'],
  extraPurgeTags: ['testimonials', 'home'],
  label: (t) => t.authorName,
});

@Controller('admin/testimonials')
@Area('inbox')
export class AdminTestimonialsController extends BaseAdminTestimonialsController {
  @Patch(':id/status')
  async setStatus(@Param('id') id: string, @Body() dto: SetTestimonialStatusDto, @Req() req: RequestContext): Promise<Testimonial> {
    const entity = await this.findOrNotFound(id);
    entity.status = dto.status;
    const saved = await this.repo.save(entity);
    this.purge();
    req.auditContext = {
      action: 'update',
      entityType: this.entityType,
      entityId: id,
      entityLabel: `${entity.authorName} — status: ${dto.status}`,
    };
    return saved;
  }

  @Patch(':id/feature')
  async setFeature(@Param('id') id: string, @Body() dto: SetTestimonialFeatureDto, @Req() req: RequestContext): Promise<Testimonial> {
    const entity = await this.findOrNotFound(id);
    entity.isFeatured = dto.isFeatured;
    const saved = await this.repo.save(entity);
    this.purge();
    req.auditContext = {
      action: 'update',
      entityType: this.entityType,
      entityId: id,
      entityLabel: `${entity.authorName} — featured: ${dto.isFeatured}`,
    };
    return saved;
  }
}
