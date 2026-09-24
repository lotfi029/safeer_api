import type { ApplicationDocType } from '../database/entities/application-document.entity.js';

/** The 3 document types `submit()` and `GET portal/documents`'s `completeness` require — confirmed against `application_documents.doc_type`'s actual enum (`id_copy | certificate | admission_letter | other`); `other` is never required. */
export const REQUIRED_DOC_TYPES: ApplicationDocType[] = ['id_copy', 'certificate', 'admission_letter'];
