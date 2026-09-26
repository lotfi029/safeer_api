import type { ApplicationDocument } from '../database/entities/application-document.entity.js';

/**
 * B19: what an applicant sees of one of their documents — never the storage
 * key, checksum or reviewer id.
 */
export interface PublicApplicationDocument {
  id: string;
  docType: ApplicationDocument['docType'];
  originalName: string;
  mime: string;
  sizeBytes: number;
  status: ApplicationDocument['status'];
  rejectionReason: string | null;
  createdAt: Date;
}

export function toPublicDocument(doc: ApplicationDocument): PublicApplicationDocument {
  return {
    id: doc.id,
    docType: doc.docType,
    originalName: doc.originalName,
    mime: doc.mime,
    sizeBytes: Number(doc.sizeBytes),
    status: doc.status,
    rejectionReason: doc.rejectionReason,
    createdAt: doc.createdAt,
  };
}

/** B19: the staff view adds review bookkeeping — still no storage key or checksum. */
export interface AdminApplicationDocument extends PublicApplicationDocument {
  reviewedBy: string | null;
  reviewedAt: Date | null;
  supersededAt: Date | null;
}

export function toAdminDocument(doc: ApplicationDocument): AdminApplicationDocument {
  return {
    ...toPublicDocument(doc),
    reviewedBy: doc.reviewedBy,
    reviewedAt: doc.reviewedAt,
    supersededAt: doc.supersededAt,
  };
}
