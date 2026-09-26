import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Application, type ApplicationStatus } from '../database/entities/application.entity.js';
import { ApplicationDocument, type ApplicationDocType } from '../database/entities/application-document.entity.js';
import { ApplicationNote } from '../database/entities/application-note.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { User } from '../database/entities/user.entity.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import type { RequestContext } from '../common/request-context.js';
import type { PagedResult } from '../common/crud/crud.factory.js';
import { escapeLikeValue, readPageLimit, readString } from '../common/query/list-params.js';
import { toCsvWithBom } from '../common/csv.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { assertRequestDocumentsAllowed, assertStatusTransition } from './transitions.js';
import type { UpdateApplicationAdminDto } from './dto/update-application.dto.js';
import type { BulkActionDto } from './dto/bulk-action.dto.js';
import type { ReviewDocumentDto } from './dto/review-document.dto.js';
import { portalLoginUrl } from '../common/links/frontend-url.js';

const STATUS_VALUES: ApplicationStatus[] = ['draft', 'new', 'under_review', 'docs_missing', 'interview', 'accepted', 'rejected'];

/** Hard cap on `export.csv` — no filter is required, so an unbounded query on a growing table would otherwise be one URL away. Comfortably above any realistic caseload; raise if the association ever nears it. */
const EXPORT_MAX_ROWS = 5000;

export interface ApplicationListItem {
  id: string;
  reference: string;
  status: ApplicationStatus;
  currentStep: number;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  university: string | null;
  degreeLevel: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  assignedReviewer: { id: string; name: string } | null;
  /** B3: a badge — every requested/rejected document type has a fresh, un-reviewed replacement. */
  hasUnreviewedResubmission: boolean;
}

export interface BulkActionResult {
  id: string;
  ok: boolean;
  error?: string;
}

function errorMessageFrom(err: unknown): string {
  if (err instanceof ProblemException) {
    const response = err.getResponse() as { title?: string };
    return response.title ?? 'Failed';
  }
  return 'Unexpected error';
}

function fullName(a: Pick<Application, 'firstName' | 'middleName' | 'lastName'>): string {
  return [a.firstName, a.middleName, a.lastName].filter(Boolean).join(' ');
}

/**
 * Hand-written (not `CrudController`-shaped, same reasoning as
 * `MessagesService`): listing/counts/CSV, single-application review,
 * document accept/reject, notes, bulk actions and the status-transition map
 * are all custom behaviour the kernel has no hook for.
 *
 * This is the "other half" of phase 6's document-review story: phase 6's
 * `portal-documents.service.ts` explicitly never auto-changes
 * `applications.status` on an upload or on `docs_missing` — reviewing a
 * document (`reviewDocument()` below) and driving the application's status
 * (`updateApplication()`/`requestDocuments()`) are deliberately kept as two
 * separate actions here too, exactly as phase 6 left them.
 */
@Injectable()
export class AdminApplicationsService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(ApplicationDocument) private readonly documentRepo: Repository<ApplicationDocument>,
    @InjectRepository(ApplicationNote) private readonly noteRepo: Repository<ApplicationNote>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(SiteSettings) private readonly settingsRepo: Repository<SiteSettings>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(SMS_SERVICE) private readonly smsService: SmsServiceInterface,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------
  // Listing, counts, export
  // -------------------------------------------------------------------

  async list(query: Record<string, unknown>): Promise<PagedResult<ApplicationListItem>> {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: 20, maxLimit: 100 });
    const qb = this.buildFilteredQuery(query);
    qb.leftJoinAndSelect('a.assignedReviewer', 'reviewer').orderBy('a.createdAt', 'DESC').addOrderBy('a.id', 'DESC');
    this.addResubmissionBadge(qb);

    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);
    const total = await qb.getCount();
    const { entities, raw } = await qb.getRawAndEntities();
    const data = entities.map((a, i) => this.toListItem(a, Boolean(raw[i]?.has_resubmission)));
    return { data, total, page, limit };
  }

  /**
   * B3 (safeer-backend-fr-review.md): a scalar EXISTS subquery, not a
   * separate query per row — `hasUnreviewedResubmission` is true exactly
   * when a `DOCS_RESUBMITTED` event (written by
   * `PortalDocumentsService.upload()` once every requested/rejected type
   * has a fresh replacement) is newer than the application's own latest
   * `DOCS_REQUESTED` event. Read via `getRawAndEntities()` since a plain
   * `addSelect` scalar has no home on the mapped `Application` entity.
   */
  private addResubmissionBadge(qb: ReturnType<Repository<Application>['createQueryBuilder']>): void {
    qb.addSelect((subQuery) => {
      return subQuery
        .select('1')
        .from(ApplicationEvent, 'resub')
        .where('resub.application_id = a.id')
        .andWhere("resub.type = 'DOCS_RESUBMITTED'")
        .andWhere(
          `resub.created_at > COALESCE((SELECT MAX(req.created_at) FROM application_events req WHERE req.application_id = a.id AND req.type = 'DOCS_REQUESTED'), '1970-01-01')`,
        )
        .limit(1);
    }, 'has_resubmission');
  }

  /** One row per `ApplicationStatus` value plus `all` — feeds the prototype's status chips. */
  async counts(): Promise<Record<ApplicationStatus, number> & { all: number }> {
    const rows = await this.applicationRepo
      .createQueryBuilder('a')
      .select('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('a.status')
      .getRawMany<{ status: ApplicationStatus; count: string }>();

    const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
    const result = {} as Record<ApplicationStatus, number> & { all: number };
    let all = 0;
    for (const status of STATUS_VALUES) {
      const count = byStatus.get(status) ?? 0;
      result[status] = count;
      all += count;
    }
    result.all = all;
    return result;
  }

  async exportCsv(query: Record<string, unknown>): Promise<string> {
    const qb = this.buildFilteredQuery(query);
    qb.leftJoinAndSelect('a.assignedReviewer', 'reviewer')
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(EXPORT_MAX_ROWS);
    const rows = await qb.getMany();

    return toCsvWithBom(rows, [
      { header: 'Reference', value: (a) => a.reference },
      { header: 'Name', value: (a) => fullName(a) },
      { header: 'Nationality', value: (a) => a.nationality },
      { header: 'University', value: (a) => a.university },
      { header: 'Degree', value: (a) => a.degreeLevel },
      { header: 'Status', value: (a) => a.status },
      { header: 'Submitted', value: (a) => (a.submittedAt ? a.submittedAt.toISOString() : '') },
      { header: 'Assigned reviewer', value: (a) => a.assignedReviewer?.name ?? '' },
    ]);
  }

  private buildFilteredQuery(query: Record<string, unknown>) {
    const qb = this.applicationRepo.createQueryBuilder('a');

    const status = readString(query, 'status');
    if (status && STATUS_VALUES.includes(status as ApplicationStatus)) {
      qb.andWhere('a.status = :status', { status });
    }

    const reviewerId = readString(query, 'reviewerId');
    if (reviewerId) {
      qb.andWhere('a.assignedReviewerId = :reviewerId', { reviewerId });
    }

    const q = readString(query, 'q');
    if (q) {
      const escaped = escapeLikeValue(q);
      qb.andWhere(
        "(a.reference LIKE :qPrefix ESCAPE '\\\\' OR CONCAT_WS(' ', a.firstName, a.middleName, a.lastName) LIKE :qLike ESCAPE '\\\\' OR a.email LIKE :qLike ESCAPE '\\\\')",
        { qPrefix: `${escaped}%`, qLike: `%${escaped}%` },
      );
    }

    return qb;
  }

  private toListItem(a: Application, hasUnreviewedResubmission = false): ApplicationListItem {
    return {
      id: a.id,
      reference: a.reference,
      status: a.status,
      currentStep: a.currentStep,
      firstName: a.firstName,
      middleName: a.middleName,
      lastName: a.lastName,
      email: a.email,
      phone: a.phone,
      nationality: a.nationality,
      university: a.university,
      degreeLevel: a.degreeLevel,
      submittedAt: a.submittedAt,
      createdAt: a.createdAt,
      assignedReviewer: a.assignedReviewer ? { id: a.assignedReviewer.id, name: a.assignedReviewer.name } : null,
      hasUnreviewedResubmission,
    };
  }

  // -------------------------------------------------------------------
  // Single application
  // -------------------------------------------------------------------

  async getDetail(id: string) {
    const application = await this.findOrNotFound(id);
    const [documents, notes, events] = await Promise.all([
      this.documentRepo.find({ where: { applicationId: id, supersededAt: IsNull() }, order: { createdAt: 'ASC' } }),
      this.noteRepo.find({ where: { applicationId: id }, relations: { author: true }, order: { createdAt: 'DESC' } }),
      // The staff view — ALL events, unlike the portal's `visibleToApplicant`-only feed.
      this.eventRepo.find({ where: { applicationId: id }, relations: { actor: true }, order: { createdAt: 'DESC' } }),
    ]);

    return {
      id: application.id,
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
      consentAt: application.consentAt,
      submittedAt: application.submittedAt,
      decidedAt: application.decidedAt,
      locale: application.locale,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      assignedReviewer: application.assignedReviewer
        ? { id: application.assignedReviewer.id, name: application.assignedReviewer.name, email: application.assignedReviewer.email }
        : null,
      documents,
      notes: notes.map((n) => ({ id: n.id, body: n.body, authorId: n.authorId, authorName: n.author?.name ?? null, createdAt: n.createdAt })),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actorId: e.actorId,
        actorName: e.actor?.name ?? null,
        visibleToApplicant: e.visibleToApplicant,
        data: e.data,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * `PATCH admin/applications/:id` — `status` and `assignedReviewerId` are
   * independent, both optional, and at least one is required. Status goes
   * through the transition map (`assertStatusTransition`); reassigning the
   * reviewer never does, per the plan ("don't require the transition map").
   */
  async updateApplication(id: string, dto: UpdateApplicationAdminDto, req: RequestContext) {
    if (dto.status === undefined && dto.assignedReviewerId === undefined) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'At least one of status or assignedReviewerId is required');
    }

    const application = await this.findOrNotFound(id);
    const before = { status: application.status, assignedReviewerId: application.assignedReviewerId };

    if (dto.status !== undefined) {
      await this.applyStatusChange(application, dto.status, req.user!.id);
    }
    if (dto.assignedReviewerId !== undefined) {
      await this.applyAssignReviewer(application, dto.assignedReviewerId, req.user!.id);
    }

    const after = { status: application.status, assignedReviewerId: application.assignedReviewerId };
    // Privacy-conscious diff (messages.service.ts / submissions.controller.ts's own pattern): before/after
    // are limited to exactly {status, assignedReviewerId} — never the applicant's name/email/phone, even
    // though this write touches the `applications` row that holds them.
    req.auditContext = {
      action: 'update',
      entityType: 'applications',
      entityId: id,
      entityLabel: `application ${application.reference}`,
      before,
      after,
    };

    return this.getDetail(id);
  }

  /**
   * Shared by `updateApplication()` and the `status` bulk action — the one
   * place `STATUS_CHANGED` is written and `application_status_changed`
   * mail/SMS is sent, so the two call sites can never drift on what a
   * "status change" means.
   */
  private async applyStatusChange(application: Application, target: ApplicationStatus, actorId: string): Promise<void> {
    assertStatusTransition(application.status, target);
    const from = application.status;
    application.status = target;
    if (target === 'accepted' || target === 'rejected') {
      application.decidedAt = new Date();
    }
    await this.applicationRepo.save(application);

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId: application.id,
        type: 'STATUS_CHANGED',
        actorId,
        visibleToApplicant: true,
        data: { from, to: target },
      }),
    );

    await this.notifyStatusChange(application, target);
  }

  /** `site_settings.notify_email_on_status_change` / `notify_sms_on_status_change` gate this — unlike request-documents/document-reject, a generic status change is opt-out-able. */
  private async notifyStatusChange(application: Application, status: ApplicationStatus): Promise<void> {
    const settings = await this.settingsRepo.findOne({ where: { id: '1' } });
    const link = portalLoginUrl(this.env, application.locale);
    const name = fullName(application);

    if (settings?.notifyEmailOnStatusChange) {
      await this.mailService.send({
        key: 'application_status_changed',
        to: application.email ?? '',
        vars: { name, reference: application.reference, status, note: '', link },
        locale: application.locale,
        entity: { type: 'applications', id: application.id },
      });
    }
    if (settings?.notifySmsOnStatusChange) {
      await this.smsService.send({
        key: 'application_status_changed',
        to: application.phoneE164 ?? application.phone ?? '',
        vars: { reference: application.reference, status },
        locale: application.locale,
        entity: { type: 'applications', id: application.id },
      });
    }
  }

  /**
   * B7 (safeer-backend-fr-review.md): the assignee must be `admin`/`reviewer`
   * and not locked — otherwise that person literally cannot open the
   * applications area (`RolesGuard` on `AdminApplicationsController`) or is
   * refused at login (`SessionGuard`/`AuthService`) despite the assignment
   * having gone through.
   */
  /** `GET admin/applications/assignees` (B7) — every account `applyAssignReviewer` would actually accept, for the reviewer picker. */
  async listAssignees(): Promise<{ id: string; name: string; email: string; role: 'admin' | 'reviewer' }[]> {
    const users = await this.userRepo.find({
      where: { role: In(['admin', 'reviewer']), isLocked: false },
      order: { name: 'ASC' },
    });
    return users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role as 'admin' | 'reviewer' }));
  }

  private async applyAssignReviewer(application: Application, reviewerId: string | null, actorId: string): Promise<void> {
    if (reviewerId !== null) {
      const reviewer = await this.userRepo.findOne({ where: { id: reviewerId } });
      if (!reviewer) {
        throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Reviewer not found');
      }
      if (!['admin', 'reviewer'].includes(reviewer.role) || reviewer.isLocked) {
        throw new ProblemException(
          422,
          ErrorCode.INVALID_ASSIGNEE,
          'Applications can only be assigned to an admin or reviewer account that is not locked',
        );
      }
    }
    application.assignedReviewerId = reviewerId;
    await this.applicationRepo.save(application);

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId: application.id,
        type: 'REVIEWER_ASSIGNED',
        actorId,
        // Internal bookkeeping, not something the applicant reads about.
        visibleToApplicant: false,
        data: { reviewerId },
      }),
    );
  }

  // -------------------------------------------------------------------
  // Bulk actions
  // -------------------------------------------------------------------

  /**
   * Each id is processed independently and failures never abort the batch
   * — the plan is explicit that a bulk operation "can partially succeed".
   * `req.auditContext` records the batch itself (action, ids, per-id
   * results), never the applicants' personal data.
   */
  async bulkAction(dto: BulkActionDto, req: RequestContext): Promise<BulkActionResult[]> {
    const results: BulkActionResult[] = [];

    for (const id of dto.ids) {
      try {
        const application = await this.applicationRepo.findOne({ where: { id } });
        if (!application) {
          throw new ProblemException(404, ErrorCode.NOT_FOUND, `Application ${id} not found`);
        }

        if (dto.action === 'assign') {
          // `bulkActionSchema`'s `superRefine` already guarantees this is present for `action: 'assign'`.
          await this.applyAssignReviewer(application, dto.reviewerId ?? null, req.user!.id);
        } else if (dto.action === 'status') {
          await this.applyStatusChange(application, dto.status!, req.user!.id);
        } else {
          await this.requestDocuments(application, dto.docTypes! as ApplicationDocType[], dto.message ?? null, req.user!.id);
        }
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: errorMessageFrom(err) });
      }
    }

    req.auditContext = {
      action: 'update',
      entityType: 'applications',
      entityLabel: `bulk ${dto.action} (${results.filter((r) => r.ok).length}/${results.length} succeeded)`,
      after: { action: dto.action, ids: dto.ids, results },
    };

    return results;
  }

  // -------------------------------------------------------------------
  // Document review and requests
  // -------------------------------------------------------------------

  /**
   * Sets `status='docs_missing'` (via `assertRequestDocumentsAllowed`, a
   * looser check than the main transition map — see transitions.ts),
   * writes a `DOCS_REQUESTED` event, and always sends `documents_requested`
   * mail/SMS — unlike `applyStatusChange()`'s generic notification, this one
   * is not gated by `site_settings`' toggles: a caseworker explicitly asking
   * for missing documents must reach the applicant regardless of the
   * association's general status-change notification preference.
   */
  async requestDocuments(application: Application, docTypes: ApplicationDocType[], message: string | null, actorId: string): Promise<void> {
    assertRequestDocumentsAllowed(application.status);
    application.status = 'docs_missing';
    await this.applicationRepo.save(application);

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId: application.id,
        type: 'DOCS_REQUESTED',
        actorId,
        visibleToApplicant: true,
        data: { docTypes, message },
      }),
    );

    const link = portalLoginUrl(this.env, application.locale);
    await this.mailService.send({
      key: 'documents_requested',
      to: application.email ?? '',
      vars: { name: fullName(application), reference: application.reference, docTypes: docTypes.join(', '), message: message ?? '', link },
      locale: application.locale,
      entity: { type: 'applications', id: application.id },
    });
    await this.smsService.send({
      key: 'documents_requested',
      to: application.phoneE164 ?? application.phone ?? '',
      vars: { reference: application.reference },
      locale: application.locale,
      entity: { type: 'applications', id: application.id },
    });
  }

  async requestDocumentsForOne(id: string, docTypes: ApplicationDocType[], message: string | null, req: RequestContext) {
    const application = await this.findOrNotFound(id);
    const before = { status: application.status };
    await this.requestDocuments(application, docTypes, message, req.user!.id);

    req.auditContext = {
      action: 'update',
      entityType: 'applications',
      entityId: id,
      entityLabel: `application ${application.reference}`,
      before,
      after: { status: application.status },
    };

    return this.getDetail(id);
  }

  /**
   * Per phase 6's design (portal-documents.service.ts), reviewing a document
   * never touches `applications.status` — that stays the admin's separate
   * job via `updateApplication()`/`requestDocuments()`. `reason` is required
   * (400) when rejecting; a `document_rejected` mail (no SMS — no such
   * template is seeded, unlike `application_status_changed`/
   * `documents_requested` which have both) is sent only on rejection.
   */
  async reviewDocument(applicationId: string, docId: string, dto: ReviewDocumentDto, req: RequestContext): Promise<ApplicationDocument> {
    if (dto.status === 'rejected' && !dto.reason) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'reason is required when rejecting a document');
    }

    const doc = await this.findDocumentOrNotFound(applicationId, docId);
    const application = await this.findOrNotFound(applicationId);
    const before = { status: doc.status, rejectionReason: doc.rejectionReason };

    doc.status = dto.status;
    doc.rejectionReason = dto.status === 'rejected' ? (dto.reason ?? null) : null;
    doc.reviewedBy = req.user!.id;
    doc.reviewedAt = new Date();
    const saved = await this.documentRepo.save(doc);

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId,
        type: dto.status === 'rejected' ? 'DOCUMENT_REJECTED' : 'DOCUMENT_ACCEPTED',
        actorId: req.user!.id,
        // Only a rejection is actionable enough to surface on the applicant's own timeline/notifications feed
        // (they also get the document_rejected mail below); an acceptance is a quiet, internal-only milestone.
        visibleToApplicant: dto.status === 'rejected',
        data: { docType: doc.docType, reason: saved.rejectionReason },
      }),
    );

    if (dto.status === 'rejected') {
      const link = portalLoginUrl(this.env, application.locale);
      await this.mailService.send({
        key: 'document_rejected',
        to: application.email ?? '',
        vars: { name: fullName(application), reference: application.reference, docType: doc.docType, reason: saved.rejectionReason ?? '', link },
        locale: application.locale,
        entity: { type: 'applications', id: applicationId },
      });
    }

    req.auditContext = {
      action: 'update',
      entityType: 'application_documents',
      entityId: docId,
      entityLabel: `${doc.docType} document on application ${application.reference}`,
      before,
      after: { status: saved.status, rejectionReason: saved.rejectionReason },
    };

    return saved;
  }

  async getDocumentForStream(applicationId: string, docId: string): Promise<ApplicationDocument> {
    return this.findDocumentOrNotFound(applicationId, docId);
  }

  // -------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------

  async addNote(applicationId: string, body: string, req: RequestContext): Promise<ApplicationNote> {
    await this.findOrNotFound(applicationId);
    const note = await this.noteRepo.save(this.noteRepo.create({ applicationId, authorId: req.user!.id, body }));

    req.auditContext = {
      action: 'create',
      entityType: 'application_notes',
      entityId: note.id,
      entityLabel: `note on application #${applicationId}`,
      after: { id: note.id, applicationId, authorId: note.authorId },
    };

    return note;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async findOrNotFound(id: string): Promise<Application> {
    const application = await this.applicationRepo.findOne({ where: { id }, relations: { assignedReviewer: true } });
    if (!application) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }
    return application;
  }

  private async findDocumentOrNotFound(applicationId: string, docId: string): Promise<ApplicationDocument> {
    const doc = await this.documentRepo.findOne({ where: { id: docId } });
    if (!doc || doc.applicationId !== applicationId) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Document not found');
    }
    return doc;
  }
}
