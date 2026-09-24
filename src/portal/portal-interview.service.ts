import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

@Injectable()
export class PortalInterviewService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(InterviewSlot) private readonly slotRepo: Repository<InterviewSlot>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
  ) {}

  /** Only meaningful once staff have moved the application to `interview` — an empty list otherwise, not an error, since the applicant is just checking their own status. */
  async listOpenSlots(applicationId: string): Promise<InterviewSlot[]> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (application?.status !== 'interview') {
      return [];
    }
    return this.slotRepo.find({ where: { applicationId: IsNull() }, order: { startsAt: 'ASC' } });
  }

  /**
   * `SELECT … FOR UPDATE` on the slot row, checked and claimed inside one
   * transaction, is what actually prevents two applicants from booking the
   * same slot — the `listOpenSlots()` read above is just a UI convenience
   * and is never trusted by itself.
   */
  async book(applicationId: string, slotId: string): Promise<InterviewSlot> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (application?.status !== 'interview') {
      throw new ProblemException(409, ErrorCode.INTERVIEW_NOT_AVAILABLE, 'No interview is currently pending for this application');
    }

    return this.slotRepo.manager.transaction(async (manager) => {
      const slot = await manager
        .createQueryBuilder(InterviewSlot, 's')
        .setLock('pessimistic_write')
        .where('s.id = :id', { id: slotId })
        .getOne();

      if (!slot) {
        throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Interview slot not found');
      }
      if (slot.applicationId !== null) {
        throw new ProblemException(409, ErrorCode.SLOT_ALREADY_BOOKED, 'This interview slot has already been booked');
      }

      slot.applicationId = applicationId;
      const saved = await manager.save(slot);

      await manager.save(
        manager.create(ApplicationEvent, {
          applicationId,
          type: 'INTERVIEW_BOOKED',
          actorId: null,
          visibleToApplicant: true,
          data: { slotId },
        }),
      );

      return saved;
    });
  }
}
