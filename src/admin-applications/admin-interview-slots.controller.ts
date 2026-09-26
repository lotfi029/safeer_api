import { Body, Controller, Delete, Inject, Logger, Param, Patch, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { createInterviewSlotSchema, updateInterviewSlotSchema } from './dto/interview-slot.dto.js';
import { Application } from '../database/entities/application.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { sendInterviewNotice } from '../portal/interview-notifier.js';
import { createZodDto } from 'nestjs-zod';

class UpdateInterviewSlotDto extends createZodDto(updateInterviewSlotSchema) {}
Object.defineProperty(UpdateInterviewSlotDto, 'name', { value: 'admin_interview_slotsUpdateSlotDto' });

const InterviewSlotCrudBase = CrudController<InterviewSlot>({
  path: 'admin/interview-slots',
  entity: InterviewSlot,
  createDto: createInterviewSlotSchema,
  updateDto: updateInterviewSlotSchema,
  // No `sortOrder` column on this entity (slots are time-ordered, not
  // manually ordered) — `sortable`/`publishable` are both correctly omitted.
  deleteArea: 'applications',
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
@Area('applications')
export class AdminInterviewSlotsController extends InterviewSlotCrudBase {
  // Property injection: the CRUD kernel owns the constructor.
  @Inject(MAIL_SERVICE) private readonly mailService!: MailServiceInterface;
  @Inject(SMS_SERVICE) private readonly smsService!: SmsServiceInterface;
  @Inject(ENV) private readonly env!: Env;
  private readonly logger = new Logger(AdminInterviewSlotsController.name);

  /**
   * C17: the time check runs against the merged values (a PATCH of only
   * `endsAt` must still end after the stored `startsAt`), and a change to a
   * *booked* slot's time or place is sent to its applicant.
   */
  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdateInterviewSlotDto, @Req() req: RequestContext): Promise<InterviewSlot> {
    const before = await this.findOrNotFound(id);
    const startsAt = new Date(dto.startsAt ?? before.startsAt);
    const endsAt = new Date(dto.endsAt ?? before.endsAt);
    if (!(endsAt > startsAt)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'endsAt must be after startsAt');
    }
    const saved = await super.update(id, dto, req);

    const changed =
      new Date(before.startsAt).getTime() !== new Date(saved.startsAt).getTime() ||
      new Date(before.endsAt).getTime() !== new Date(saved.endsAt).getTime() ||
      before.locationAr !== saved.locationAr ||
      before.locationEn !== saved.locationEn;
    if (saved.applicationId && changed) {
      try {
        const application = await this.dataSource.manager.findOne(Application, { where: { id: saved.applicationId } });
        if (application) {
          await sendInterviewNotice({ env: this.env, mail: this.mailService, sms: this.smsService }, 'interview_updated', application, saved);
        }
      } catch (err) {
        this.logger.error('interview_updated notification failed', err instanceof Error ? err.stack : String(err));
      }
    }
    return saved;
  }

  @Area('applications')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const slot = await this.findOrNotFound(id);
    if (slot.applicationId !== null) {
      throw new ProblemException(409, ErrorCode.RESOURCE_IN_USE, `Interview slot #${id} is already booked and cannot be deleted`);
    }
    return super.remove(id, req);
  }
}
