import { Controller, Delete, Param, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { createInterviewSlotSchema, updateInterviewSlotSchema } from './dto/interview-slot.dto.js';

const InterviewSlotCrudBase = CrudController<InterviewSlot>({
  path: 'admin/interview-slots',
  entity: InterviewSlot,
  createDto: createInterviewSlotSchema,
  updateDto: updateInterviewSlotSchema,
  // No `sortOrder` column on this entity (slots are time-ordered, not
  // manually ordered) — `sortable`/`publishable` are both correctly omitted.
  deleteRoles: ['admin', 'reviewer'],
  label: (s) => `interview slot #${s.id}`,
});

/**
 * `admin/interview-slots` — plain `CrudController` for everything except
 * `DELETE`, which the kernel's own `RESOURCE_IN_USE` FK-violation guard
 * (crud.factory.ts's `isRowReferencedError`) can't catch: `application_id`
 * is a nullable column, not a required FK, so deleting a booked slot
 * succeeds at the database level and would silently orphan
 * `portal/interview`'s booking. This overrides `remove()` with an explicit
 * pre-check instead.
 *
 * C4/B0-4 (crud.factory.ts): overriding `remove()` replaces the generated
 * method's function object, so its `@Roles`/`@Delete` metadata has to be
 * re-applied here — the base class's own decorators don't carry over.
 */
@Controller('admin/interview-slots')
@Roles('admin', 'reviewer')
export class AdminInterviewSlotsController extends InterviewSlotCrudBase {
  @Roles('admin', 'reviewer')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const slot = await this.findOrNotFound(id);
    if (slot.applicationId !== null) {
      throw new ProblemException(409, ErrorCode.RESOURCE_IN_USE, `Interview slot #${id} is already booked and cannot be deleted`);
    }
    return super.remove(id, req);
  }
}
