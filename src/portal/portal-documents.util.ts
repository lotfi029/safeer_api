import { IsNull, type Repository } from 'typeorm';
import { ApplicationDocument, type ApplicationDocType } from '../database/entities/application-document.entity.js';
import { REQUIRED_DOC_TYPES } from './required-doc-types.js';

export interface Completeness {
  done: number;
  required: number;
  missingTypes: ApplicationDocType[];
}

/**
 * "Has a current, non-rejected document" per required type — shared by
 * `submit()` (blocks with 409 `DOCUMENTS_INCOMPLETE` otherwise),
 * `GET portal/documents` (the `completeness` summary) and
 * `POST portal/documents` (whether this upload just completed a
 * previously-missing slot, to decide whether to write a `DOCS_RECEIVED`
 * event). "Current" = `superseded_at IS NULL`; "non-rejected" means
 * `under_review` or `accepted` both count — a document doesn't have to be
 * accepted yet to satisfy the requirement, only to not have been rejected
 * outright with nothing newer replacing it.
 */
export async function computeCompleteness(
  docRepo: Repository<ApplicationDocument>,
  applicationId: string,
): Promise<Completeness> {
  const rows = await docRepo.find({ where: { applicationId, supersededAt: IsNull() } });
  const satisfied = new Set(rows.filter((r) => r.status !== 'rejected').map((r) => r.docType));
  const missingTypes = REQUIRED_DOC_TYPES.filter((t) => !satisfied.has(t));
  return { done: REQUIRED_DOC_TYPES.length - missingTypes.length, required: REQUIRED_DOC_TYPES.length, missingTypes };
}
