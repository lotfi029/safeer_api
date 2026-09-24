import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application, type ApplicationStatus } from '../database/entities/application.entity.js';
import { ApplicationDocument } from '../database/entities/application-document.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { highestStepInPayload } from '../applications/application-fields.schema.js';
import { deriveTimeline } from './portal-timeline.js';
import { computeCompleteness } from './portal-documents.util.js';
import type { UpdateApplicationDto } from './dto/update-application.dto.js';
import type { SubmitApplicationDto } from './dto/submit-application.dto.js';

/** `status` values a PATCH or a submit may still act on — everything past this point is staff-owned (phase 7's review flow). */
const EDITABLE_STATUSES: ApplicationStatus[] = ['draft', 'docs_missing'];

export interface ActionNeeded {
  type: 'document_rejected' | 'documents_requested';
  docType?: string;
  docTypes?: string[];
  reason?: string | null;
  message?: string | null;
}

export interface PortalMeResult {
  reference: string;
  status: ApplicationStatus;
  currentStep: number;
  personal: {
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    birthDate: string | null;
    phone: string | null;
    nationality: string | null;
    idNumber: string | null;
    email: string | null;
    currentJob: string | null;
    gender: string | null;
  };
  study: {
    university: string | null;
    major: string | null;
    degreeLevel: string | null;
    scholarshipNote: string | null;
  };
  submittedAt: Date | null;
  decidedAt: Date | null;
  timeline: ReturnType<typeof deriveTimeline>;
  actionNeeded: ActionNeeded | null;
  recentEvents: { id: string; type: string; data: Record<string, unknown> | null; createdAt: Date }[];
}

@Injectable()
export class PortalApplicationService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(ApplicationDocument) private readonly documentRepo: Repository<ApplicationDocument>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(SMS_SERVICE) private readonly smsService: SmsServiceInterface,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------
  // PATCH portal/application — autosave
  // -------------------------------------------------------------------

  /**
   * Merges any subset of step 1–3 fields into the draft and, on
   * `consent: true`, stamps `consent_at`. `current_step` only ever moves
   * forward: it is set to `max(current, highest step touched by this
   * payload)`, so an applicant revisiting an earlier step to fix a typo
   * never regresses the step the UI resumes them on. No mail/SMS — a plain
   * autosave is not an event worth notifying anyone about.
   */
  async patch(applicationId: string, dto: UpdateApplicationDto): Promise<{ status: ApplicationStatus; currentStep: number }> {
    const application = await this.findEditable(applicationId);

    const keys = Object.keys(dto);
    Object.assign(application, this.toEntityPatch(dto));
    if (dto.consent === true && !application.consentAt) {
      application.consentAt = new Date();
    }
    application.currentStep = Math.max(application.currentStep, highestStepInPayload(keys));

    await this.applicationRepo.save(application);
    return { status: application.status, currentStep: application.currentStep };
  }

  // -------------------------------------------------------------------
  // POST portal/application/submit
  // -------------------------------------------------------------------

  /**
   * Only reachable from `draft` (not `docs_missing`) — resubmitting the
   * full form once an application has already gone through the pipeline
   * once would silently reset `status` back to `new` and re-fire
   * `application_submitted`, undoing whatever staff review already
   * happened. An applicant in `docs_missing` acts through
   * `POST portal/documents` instead (which never touches `status` itself —
   * see that service's own comment on why re-review is left to phase 7).
   */
  async submit(applicationId: string, dto: SubmitApplicationDto): Promise<{ status: ApplicationStatus; submittedAt: Date }> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (!application) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }
    if (application.status !== 'draft') {
      throw new ProblemException(
        409,
        ErrorCode.APPLICATION_LOCKED,
        'This application has already been submitted and can no longer be resubmitted',
      );
    }

    const completeness = await computeCompleteness(this.documentRepo, applicationId);
    if (completeness.missingTypes.length > 0) {
      throw new ProblemException(
        409,
        ErrorCode.DOCUMENTS_INCOMPLETE,
        'One or more required documents are missing or were rejected',
        { missing: completeness.missingTypes },
      );
    }

    Object.assign(application, this.toEntityPatch(dto));
    application.consentAt = application.consentAt ?? new Date();
    application.currentStep = 3;
    application.status = 'new';
    application.submittedAt = new Date();
    await this.applicationRepo.save(application);

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId,
        type: 'SUBMITTED',
        actorId: null,
        visibleToApplicant: true,
        data: { reference: application.reference },
      }),
    );

    const link = `${this.env.PUBLIC_BASE_URL}/portal`;
    const name = `${application.firstName ?? ''} ${application.lastName ?? ''}`.trim();
    await this.mailService.send({
      key: 'application_submitted',
      to: application.email ?? '',
      vars: { name, reference: application.reference, link },
      locale: application.locale,
      entity: { type: 'applications', id: applicationId },
    });
    await this.smsService.send({
      key: 'application_submitted',
      to: application.phone ?? '',
      vars: { reference: application.reference },
      locale: application.locale,
      entity: { type: 'applications', id: applicationId },
    });

    return { status: application.status, submittedAt: application.submittedAt };
  }

  // -------------------------------------------------------------------
  // GET portal/me
  // -------------------------------------------------------------------

  async getMe(applicationId: string): Promise<PortalMeResult> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (!application) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }

    const hadInterview = (await this.eventRepo.count({ where: { applicationId, type: 'INTERVIEW_BOOKED' } })) > 0;
    const timeline = deriveTimeline(application.status, hadInterview);
    const actionNeeded = await this.computeActionNeeded(applicationId);
    const recentEvents = await this.eventRepo.find({
      where: { applicationId, visibleToApplicant: true },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    return {
      reference: application.reference,
      status: application.status,
      currentStep: application.currentStep,
      personal: {
        firstName: application.firstName,
        middleName: application.middleName,
        lastName: application.lastName,
        birthDate: application.birthDate,
        phone: application.phone,
        nationality: application.nationality,
        idNumber: application.idNumber,
        email: application.email,
        currentJob: application.currentJob,
        gender: application.gender,
      },
      study: {
        university: application.university,
        major: application.major,
        degreeLevel: application.degreeLevel,
        scholarshipNote: application.scholarshipNote,
      },
      submittedAt: application.submittedAt,
      decidedAt: application.decidedAt,
      timeline,
      actionNeeded,
      recentEvents: recentEvents.map((e) => ({ id: e.id, type: e.type, data: e.data, createdAt: e.createdAt })),
    };
  }

  // -------------------------------------------------------------------
  // GET portal/notifications
  // -------------------------------------------------------------------

  async listNotifications(
    applicationId: string,
    page: number,
    limit: number,
  ): Promise<{ data: ApplicationEvent[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.eventRepo.findAndCount({
      where: { applicationId, visibleToApplicant: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  countNotifications(applicationId: string): Promise<number> {
    return this.eventRepo.count({ where: { applicationId, visibleToApplicant: true } });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * `actionNeeded` is non-null in exactly two cases (the plan's wording):
   * a current document was rejected with a reason, or the most recent
   * visible event is a documents-request. A rejected document takes
   * priority — it is the more specific, actionable signal, and staff
   * normally pair a rejection with a `DOCS_REQUESTED` event anyway (see
   * the dev-sample data), so checking the document first avoids reporting
   * the same situation twice under two different shapes.
   */
  private async computeActionNeeded(applicationId: string): Promise<ActionNeeded | null> {
    const rejectedDoc = await this.documentRepo.findOne({
      where: { applicationId, status: 'rejected', supersededAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    if (rejectedDoc) {
      return { type: 'document_rejected', docType: rejectedDoc.docType, reason: rejectedDoc.rejectionReason };
    }

    const latestEvent = await this.eventRepo.findOne({
      where: { applicationId, visibleToApplicant: true },
      order: { createdAt: 'DESC' },
    });
    if (latestEvent?.type === 'DOCS_REQUESTED') {
      const data = (latestEvent.data ?? {}) as { docTypes?: string[]; message?: string };
      return { type: 'documents_requested', docTypes: data.docTypes ?? [], message: data.message ?? null };
    }

    return null;
  }

  private async findEditable(applicationId: string): Promise<Application> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (!application) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }
    if (!EDITABLE_STATUSES.includes(application.status)) {
      throw new ProblemException(
        409,
        ErrorCode.APPLICATION_LOCKED,
        'This application can no longer be edited from the portal',
      );
    }
    return application;
  }

  /** Strips `consent` (not a column) and undefined keys before `Object.assign`ing onto the entity. */
  private toEntityPatch(dto: UpdateApplicationDto | SubmitApplicationDto): Partial<Application> {
    const { consent: _consent, ...rest } = dto as UpdateApplicationDto & { consent?: boolean };
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) patch[key] = value;
    }
    return patch as Partial<Application>;
  }
}
