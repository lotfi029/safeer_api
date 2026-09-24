import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { ApplicationDocument, type ApplicationDocType } from '../database/entities/application-document.entity.js';
import { ApplicationEvent } from '../database/entities/application-event.entity.js';
import { PrivateFileStore } from '../storage/private-file-store.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { computeCompleteness, type Completeness } from './portal-documents.util.js';

const DOC_TYPES: ApplicationDocType[] = ['id_copy', 'certificate', 'admission_letter', 'other'];

@Injectable()
export class PortalDocumentsService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(ApplicationDocument) private readonly documentRepo: Repository<ApplicationDocument>,
    @InjectRepository(ApplicationEvent) private readonly eventRepo: Repository<ApplicationEvent>,
    private readonly fileStore: PrivateFileStore,
  ) {}

  async list(applicationId: string): Promise<{ documents: ApplicationDocument[]; completeness: Completeness }> {
    const [documents, completeness] = await Promise.all([
      this.documentRepo.find({ where: { applicationId, supersededAt: IsNull() }, order: { createdAt: 'ASC' } }),
      computeCompleteness(this.documentRepo, applicationId),
    ]);
    return { documents, completeness };
  }

  /**
   * Any current (non-superseded) document of the same `docType` is marked
   * `superseded_at = NOW()` in the same transaction as the new row's
   * insert — "current" always means "the newest upload of this type",
   * never a history of every attempt kept side by side.
   *
   * Writes `DOCS_RECEIVED` only when this upload increases
   * `computeCompleteness()`'s `done` count — i.e. it fills a required slot
   * that was previously empty or rejected. Re-uploading an already-
   * satisfied slot (a clearer scan of an already-`accepted` id_copy) or
   * uploading the `other` type changes nothing about completeness, so no
   * event fires; that mirrors `application_events` being a log of
   * meaningful progress, not raw upload activity.
   *
   * Deliberately never touches `application.status` itself, even when the
   * application was `docs_missing` and this upload replaces the very
   * document that was rejected: whether a fresh upload is good enough is a
   * judgment call for phase 7's admin review, not something this endpoint
   * should decide unilaterally by flipping the applicant straight back to
   * `under_review`. The event is recorded so a reviewer sees it; the status
   * transition is theirs to make.
   */
  async upload(applicationId: string, docType: string, file: Express.Multer.File): Promise<ApplicationDocument> {
    if (!DOC_TYPES.includes(docType as ApplicationDocType)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `docType must be one of: ${DOC_TYPES.join(', ')}`);
    }
    if (!file?.buffer?.length) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'A file is required — send it as the multipart field "file"');
    }

    const before = await computeCompleteness(this.documentRepo, applicationId);
    const stored = await this.fileStore.store(file.buffer, file.originalname, applicationId);

    const saved = await this.documentRepo.manager.transaction(async (manager) => {
      const docRepo = manager.getRepository(ApplicationDocument);
      const existing = await docRepo.findOne({
        where: { applicationId, docType: docType as ApplicationDocType, supersededAt: IsNull() },
      });
      if (existing) {
        existing.supersededAt = new Date();
        await docRepo.save(existing);
      }

      return docRepo.save(
        docRepo.create({
          applicationId,
          docType: docType as ApplicationDocType,
          originalName: file.originalname.slice(0, 255),
          storageKey: stored.storageKey,
          mime: stored.mime,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          status: 'under_review',
        }),
      );
    });

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

    return saved;
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
