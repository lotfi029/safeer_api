import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { sendInterviewNotice, type InterviewNotice } from './interview-notifier.js';

/** What an applicant sees of a slot — never another applicant's booking. */
export interface PublicInterviewSlot {
  id: string;
  startsAt: Date;
  endsAt: Date;
  locationAr: string | null;
  locationEn: string | null;
}

export function toPublicSlot(slot: InterviewSlot): PublicInterviewSlot {
  return { id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, locationAr: slot.locationAr, locationEn: slot.locationEn };
}

@Injectable()
export class PortalInterviewService {
  private readonly logger = new Logger(PortalInterviewService.name);

  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(InterviewSlot) private readonly slotRepo: Repository<InterviewSlot>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(SMS_SERVICE) private readonly smsService: SmsServiceInterface,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * C17: open, *future* slots — and none at all once this application has
   * booked one (the portal shows the booking instead; to move it, the
   * applicant cancels first). Empty, not an error, before staff have moved
   * the application to `interview`.
   */
  async listOpenSlots(applicationId: string): Promise<PublicInterviewSlot[]> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (application?.status !== 'interview') return [];
    if (await this.slotRepo.exists({ where: { applicationId } })) return [];
    const slots = await this.slotRepo.find({
      where: { applicationId: IsNull(), startsAt: MoreThan(new Date()) },
      order: { startsAt: 'ASC' },
    });
    return slots.map(toPublicSlot);
  }

  /** C17: this application's booked slot, if any — `/portal/me`'s `interview`. */
  async bookedSlot(applicationId: string): Promise<PublicInterviewSlot | null> {
    const slot = await this.slotRepo.findOne({ where: { applicationId } });
    return slot ? toPublicSlot(slot) : null;
  }

  /**
   * The application row and the slot row are both locked
   * (`pessimistic_write`) inside one transaction: two applicants can't take
   * the same slot, one applicant can't take two (C17: a second booking is
   * SLOT_ALREADY_BOOKED, not the generic unique-key 409), and a past slot
   * can't be booked.
   */
  async book(applicationId: string, slotId: string): Promise<PublicInterviewSlot> {
    const { application, slot } = await this.slotRepo.manager.transaction(async (manager) => {
      const locked = await this.lockInterviewApplication(manager, applicationId);
      const existing = await manager.findOne(InterviewSlot, { where: { applicationId } });
      if (existing) {
        throw new ProblemException(409, ErrorCode.SLOT_ALREADY_BOOKED, 'You already have a booked interview — cancel it first to choose another time');
      }

      const slotRow = await manager
        .createQueryBuilder(InterviewSlot, 's')
        .setLock('pessimistic_write')
        .where('s.id = :id', { id: slotId })
        .getOne();
      if (!slotRow) {
        throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Interview slot not found');
      }
      if (slotRow.applicationId !== null) {
        throw new ProblemException(409, ErrorCode.SLOT_ALREADY_BOOKED, 'This interview slot has already been booked');
      }
      if (new Date(slotRow.startsAt) <= new Date()) {
        throw new ProblemException(409, ErrorCode.INTERVIEW_NOT_AVAILABLE, 'This interview slot has already passed');
      }

      slotRow.applicationId = applicationId;
      const saved = await manager.save(slotRow);
      await manager.save(
        manager.create(ApplicationEvent, {
          applicationId,
          type: 'INTERVIEW_BOOKED',
          actorId: null,
          visibleToApplicant: true,
          data: { slotId },
        }),
      );
      return { application: locked, slot: saved };
    });

    await this.notify('interview_booked', application, slot);
    return toPublicSlot(slot);
  }

  /**
   * C17: `DELETE portal/interview` — frees the applicant's booked slot so
   * another time can be chosen. Locked the same way as booking; a slot that
   * has already started can't be cancelled from the portal.
   */
  async cancel(applicationId: string): Promise<{ cancelled: true }> {
    const { application, slot } = await this.slotRepo.manager.transaction(async (manager) => {
      const locked = await this.lockInterviewApplication(manager, applicationId);
      const slotRow = await manager
        .createQueryBuilder(InterviewSlot, 's')
        .setLock('pessimistic_write')
        .where('s.application_id = :applicationId', { applicationId })
        .getOne();
      if (!slotRow) {
        throw new ProblemException(404, ErrorCode.NOT_FOUND, 'No interview is booked');
      }
      if (new Date(slotRow.startsAt) <= new Date()) {
        throw new ProblemException(409, ErrorCode.INTERVIEW_NOT_AVAILABLE, 'This interview has already started or passed');
      }
      slotRow.applicationId = null;
      await manager.save(slotRow);
      await manager.save(
        manager.create(ApplicationEvent, {
          applicationId,
          type: 'INTERVIEW_CANCELLED',
          actorId: null,
          visibleToApplicant: true,
          data: { slotId: slotRow.id },
        }),
      );
      return { application: locked, slot: slotRow };
    });

    await this.notify('interview_cancelled', application, slot);
    return { cancelled: true };
  }

  private async lockInterviewApplication(manager: EntityManager, applicationId: string): Promise<Application> {
    const application = await manager
      .createQueryBuilder(Application, 'a')
      .setLock('pessimistic_write')
      .where('a.id = :id', { id: applicationId })
      .getOne();
    if (application?.status !== 'interview') {
      throw new ProblemException(409, ErrorCode.INTERVIEW_NOT_AVAILABLE, 'No interview is currently pending for this application');
    }
    return application;
  }

  private async notify(key: InterviewNotice, application: Application, slot: InterviewSlot): Promise<void> {
    try {
      await sendInterviewNotice({ env: this.env, mail: this.mailService, sms: this.smsService }, key, application, slot);
    } catch (err) {
      this.logger.error(`${key} notification failed`, err instanceof Error ? err.stack : String(err));
    }
  }
}
