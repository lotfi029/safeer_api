import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationDocument, type ApplicationDocType } from '../database/entities/application-document.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { PrivateFileStore } from '../storage/private-file-store.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { computeCompleteness, type Completeness } from './portal-documents.util.js';
import { toPublicDocument, type PublicApplicationDocument } from './public-document.js';
import { decodeUploadName } from '../common/http/filenames.js';

const DOC_TYPES: ApplicationDocType[] = ['id_copy', 'certificate', 'admission_letter', 'other'];

/** C18: per-application upload quota — every upload counts, including ones later replaced. */
export const MAX_UPLOADS_PER_APPLICATION = 30;
export const MAX_UPLOAD_BYTES_PER_APPLICATION = 50 * 1024 * 1024;

@Injectable()
export class PortalDocumentsService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(ApplicationDocument) private readonly documentRepo: Repository<ApplicationDocument>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
    private readonly fileStore: PrivateFileStore,
  ) {}

  async list(applicationId: string): Promise<{ documents: PublicApplicationDocument[]; completeness: Completeness }> {
    const [documents, completeness] = await Promise.all([
      this.documentRepo.find({ where: { applicationId, supersededAt: IsNull() }, order: { createdAt: 'ASC' } }),
      computeCompleteness(this.documentRepo, applicationId),
    ]);
    return { documents: documents.map(toPublicDocument), completeness };
  }

  /**
   * B3 (safeer-backend-fr-review.md): allowed only while the application is
   * `draft`, or while it's `docs_missing` and `docType` is one of the types
   * a reviewer actually asked for (the latest `DOCS_REQUESTED` event's
   * `docTypes`) or currently sits rejected. Anything else — `new`,
   * `under_review`, `interview`, `accepted`, `rejected`, or a `docType` in
   * `docs_missing` that wasn't requested/rejected — is `APPLICATION_LOCKED`.
   * A document whose current row is `accepted` is never superseded, even if
   * somehow named in a request (a caseworker's mistake, never the
   * applicant's to act on).
   *
   * Any current (non-superseded) document of the same `docType` is marked
   * `superseded_at = NOW()` in the same transaction as the new row's
   * insert — "current" always means "the newest upload of this type",
   * never a history of every attempt kept side by side. If the transaction
   * fails after the file was written to disk, the orphaned file is removed
   * — `store()` runs first (outside the transaction, since TypeORM has no
   * hook to run "on rollback"), so a DB failure must not leave a stranded
   * file with nothing pointing at it.
   *
   * Writes `DOCS_RECEIVED` only when this upload increases
   * `computeCompleteness()`'s `done` count — i.e. it fills a required slot
   * that was previously empty or rejected. Re-uploading an already-
   * satisfied slot (a clearer scan of an already-`accepted` id_copy) or
   * uploading the `other` type changes nothing about completeness, so no
   * event fires; that mirrors `application_events` being a log of
   * meaningful progress, not raw upload activity. Separately, when this
   * upload is the *last* of the requested/rejected types to get a fresh
   * replacement while `docs_missing`, a `DOCS_RESUBMITTED` event is
   * recorded — visible to staff only, a badge for the admin list
   * (`AdminApplicationsService.list`) — without touching `status` itself:
   * whether a fresh upload is good enough is still a judgment call for
   * admin review, never something this endpoint decides unilaterally.
   */
  async upload(applicationId: string, docType: string, file: Express.Multer.File): Promise<PublicApplicationDocument> {
    if (!DOC_TYPES.includes(docType as ApplicationDocType)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `docType must be one of: ${DOC_TYPES.join(', ')}`);
    }
    if (!file?.buffer?.length) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'A file is required — send it as the multipart field "file"');
    }
    const type = docType as ApplicationDocType;
    const originalName = decodeUploadName(file.originalname); // C19

    // A cheap pre-check before any bytes are written, so a locked
    // application or a spent quota never costs a disk/bucket write. The
    // authoritative check repeats below under the row lock.
    const pre = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (!pre) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }
    await this.checkUploadAllowed(this.applicationRepo.manager, pre.status, applicationId, type, file.buffer.length);

    const before = await computeCompleteness(this.documentRepo, applicationId);
    const stored = await this.fileStore.store(file.buffer, originalName, applicationId);

    let saved: ApplicationDocument;
    let superseded: ApplicationDocument | null;
    let neededTypes: ApplicationDocType[] | null;
    try {
      ({ saved, superseded, neededTypes } = await this.documentRepo.manager.transaction(async (manager) => {
        // B3: the status/lock/quota rules are checked against the row as it
        // is *now*, under pessimistic_write — a staff status change or a
        // parallel upload can't slip in between the check and the write.
        const application = await manager
          .createQueryBuilder(Application, 'a')
          .setLock('pessimistic_write')
          .where('a.id = :id', { id: applicationId })
          .getOne();
        if (!application) {
          throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
        }
        const needed = await this.checkUploadAllowed(manager, application.status, applicationId, type, file.buffer.length);

        const docRepo = manager.getRepository(ApplicationDocument);
        const existing = await docRepo.findOne({ where: { applicationId, docType: type, supersededAt: IsNull() } });
        if (existing) {
          existing.supersededAt = new Date();
          await docRepo.save(existing);
        }

        const created = await docRepo.save(
          docRepo.create({
            applicationId,
            docType: type,
            originalName,
            storageKey: stored.storageKey,
            mime: stored.mime,
            sizeBytes: stored.sizeBytes,
            checksum: stored.checksum,
            status: 'under_review',
          }),
        );
        return { saved: created, superseded: existing, neededTypes: needed };
      }));
    } catch (err) {
      // The file was already written before the transaction ran — a
      // refused or failed write must not leave it orphaned (B3).
      await this.fileStore.remove(stored.storageKey);
      throw err;
    }

    // C18: the replaced upload's bytes go once the new row is committed —
    // its row stays (history, and it still counts towards the quota).
    if (superseded) {
      await this.fileStore.remove(superseded.storageKey);
    }

    const after = await computeCompleteness(this.documentRepo, applicationId);
    if (after.done > before.done) {
      await this.eventRepo.save(
        this.eventRepo.create({
          applicationId,
          type: 'DOCS_RECEIVED',
          actorId: null,
          visibleToApplicant: true,
          data: { docType },
        }),
      );
    }

    if (neededTypes && neededTypes.length > 0) {
      await this.maybeRecordResubmission(applicationId, neededTypes);
    }

    return toPublicDocument(saved);
  }

  /**
   * B3 + C18 in one place, run twice per upload (a cheap pre-check before
   * the file is stored, then under the application row lock): the status
   * rules (`assertUploadAllowed`) and the per-application quota —
   * MAX_UPLOADS_PER_APPLICATION rows (superseded ones included, so
   * re-uploading the same slot over and over still runs out) and
   * MAX_UPLOAD_BYTES_PER_APPLICATION bytes across them. Returns the
   * `docs_missing` resubmission types (null otherwise).
   */
  private async checkUploadAllowed(
    manager: EntityManager,
    status: Application['status'],
    applicationId: string,
    docType: ApplicationDocType,
    incomingBytes: number,
  ): Promise<ApplicationDocType[] | null> {
    const docRepo = manager.getRepository(ApplicationDocument);
    const existing = await docRepo.findOne({ where: { applicationId, docType, supersededAt: IsNull() } });
    const neededTypes = status === 'docs_missing' ? await this.neededResubmissionTypes(applicationId, manager) : null;
    this.assertUploadAllowed(status, docType, existing, neededTypes);

    const [usage]: Array<{ files: number | string; bytes: number | string | null }> = await manager.query(
      'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM application_documents WHERE application_id = ?',
      [applicationId],
    );
    if (Number(usage.files) + 1 > MAX_UPLOADS_PER_APPLICATION || Number(usage.bytes) + incomingBytes > MAX_UPLOAD_BYTES_PER_APPLICATION) {
      throw new ProblemException(
        409,
        ErrorCode.QUOTA_EXCEEDED,
        `This application has reached its upload limit (${MAX_UPLOADS_PER_APPLICATION} files / ${MAX_UPLOAD_BYTES_PER_APPLICATION / (1024 * 1024)} MB)`,
      );
    }
    return neededTypes;
  }

  /**
   * The set of doc types that need a fresh upload while `docs_missing`:
   * the latest `DOCS_REQUESTED` event's `docTypes`, unioned with every
   * `docType` whose current (non-superseded) document is `rejected` right
   * now — a caseworker rejecting one document type outright, without a
   * separate request-documents call, still needs a fresh copy the same way.
   */
  private async neededResubmissionTypes(applicationId: string, manager: EntityManager = this.documentRepo.manager): Promise<ApplicationDocType[]> {
    const [lastRequest, current] = await Promise.all([
      manager.getRepository(ApplicationEvent).findOne({ where: { applicationId, type: 'DOCS_REQUESTED' }, order: { createdAt: 'DESC' } }),
      manager.getRepository(ApplicationDocument).find({ where: { applicationId, supersededAt: IsNull() } }),
    ]);
    const requested = ((lastRequest?.data as { docTypes?: ApplicationDocType[] } | null)?.docTypes ?? []).filter((t) =>
      DOC_TYPES.includes(t),
    );
    const rejected = current.filter((d) => d.status === 'rejected').map((d) => d.docType);
    return [...new Set([...requested, ...rejected])];
  }

  /** B3: throws APPLICATION_LOCKED unless this upload is allowed at the application's current status. */
  private assertUploadAllowed(
    status: Application['status'],
    docType: ApplicationDocType,
    existing: ApplicationDocument | null,
    neededTypes: ApplicationDocType[] | null,
  ): void {
    if (existing?.status === 'accepted') {
      throw new ProblemException(409, ErrorCode.APPLICATION_LOCKED, 'This document has already been accepted and cannot be replaced');
    }
    if (status === 'draft') {
      return;
    }
    if (status === 'docs_missing' && neededTypes?.includes(docType)) {
      return;
    }
    throw new ProblemException(
      409,
      ErrorCode.APPLICATION_LOCKED,
      status === 'docs_missing'
        ? 'This document type was not requested — only rejected or requested documents can be replaced right now'
        : 'Documents can only be uploaded while the application is a draft or missing requested documents',
    );
  }

  /**
   * Fires `DOCS_RESUBMITTED` (staff-only) the moment every type in
   * `neededTypes` has a current, non-rejected document again — i.e. this
   * upload was the last one still outstanding. Guarded against firing twice
   * for the same request: skipped if a `DOCS_RESUBMITTED` event already
   * exists newer than the latest `DOCS_REQUESTED` event.
   */
  private async maybeRecordResubmission(applicationId: string, neededTypes: ApplicationDocType[]): Promise<void> {
    const current = await this.documentRepo.find({ where: { applicationId, supersededAt: IsNull() } });
    const stillOutstanding = neededTypes.some((t) => {
      const doc = current.find((d) => d.docType === t);
      return !doc || doc.status === 'rejected';
    });
    if (stillOutstanding) return;

    const [lastRequest, lastResubmission] = await Promise.all([
      this.eventRepo.findOne({ where: { applicationId, type: 'DOCS_REQUESTED' }, order: { createdAt: 'DESC' } }),
      this.eventRepo.findOne({ where: { applicationId, type: 'DOCS_RESUBMITTED' }, order: { createdAt: 'DESC' } }),
    ]);
    if (lastResubmission && lastRequest && lastResubmission.createdAt > lastRequest.createdAt) {
      return; // already recorded for this request
    }

    await this.eventRepo.save(
      this.eventRepo.create({
        applicationId,
        type: 'DOCS_RESUBMITTED',
        actorId: null,
        visibleToApplicant: false,
        data: { docTypes: neededTypes },
      }),
    );
  }

  /** 404/403 (as 404 — never reveal a document id belongs to someone else) unless `doc.applicationId` matches the caller. */
  async findOwned(applicationId: string, documentId: string): Promise<ApplicationDocument> {
    const doc = await this.documentRepo.findOne({ where: { id: documentId } });
    if (!doc || doc.applicationId !== applicationId) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Document not found');
    }
    return doc;
  }

  /** Only while the application is still `draft` — once submitted, a document is part of the record staff review. */
  async remove(applicationId: string, documentId: string): Promise<void> {
    const application = await this.applicationRepo.findOne({ where: { id: applicationId } });
    if (!application) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Application not found');
    }
    if (application.status !== 'draft') {
      throw new ProblemException(409, ErrorCode.APPLICATION_LOCKED, 'Documents can only be removed while the application is a draft');
    }

    const doc = await this.findOwned(applicationId, documentId);
    await this.documentRepo.remove(doc);
    await this.fileStore.remove(doc.storageKey);
  }
}
