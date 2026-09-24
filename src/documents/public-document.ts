import type { SafeerDocument } from '../database/entities/document.entity.js';
import type { DocCategory } from '../database/entities/doc-category.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

export interface PublicDocCategory {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string | null;
}

export function toPublicDocCategory(category: DocCategory): PublicDocCategory {
  return { id: category.id, slug: category.slug, nameAr: category.nameAr, nameEn: category.nameEn };
}

/** `asset` carries `publicId` — downloads go through the existing `/files/:publicId` media pipeline, no dedicated download route here. */
export interface PublicDocument {
  id: string;
  titleAr: string;
  titleEn: string | null;
  docDate: string | null;
  asset: PublicMediaAsset | null;
  sortOrder: number;
}

export function toPublicDocument(doc: SafeerDocument): PublicDocument {
  return {
    id: doc.id,
    titleAr: doc.titleAr,
    titleEn: doc.titleEn,
    docDate: doc.docDate,
    asset: toPublicAsset(doc.asset),
    sortOrder: doc.sortOrder,
  };
}

export interface PublicDocumentGroup {
  category: PublicDocCategory;
  documents: PublicDocument[];
}
