import type { Licence } from '../database/entities/licence.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

/**
 * What GET /licences serves. `titleAr/En` and `issuerAr/En` stay as pairs so
 * LocaleInterceptor collapses them into `title` / `issuer`. The document is
 * served by /files/:publicId like every other asset.
 */
export interface PublicLicence {
  id: string;
  titleAr: string;
  titleEn: string | null;
  number: string | null;
  issuerAr: string | null;
  issuerEn: string | null;
  /** YYYY-MM-DD */
  issuedOn: string | null;
  /** YYYY-MM-DD */
  expiresOn: string | null;
  isPrimary: boolean;
  asset: PublicMediaAsset | null;
}

export function toPublicLicence(licence: Licence): PublicLicence {
  return {
    id: licence.id,
    titleAr: licence.titleAr,
    titleEn: licence.titleEn,
    number: licence.number,
    issuerAr: licence.issuerAr,
    issuerEn: licence.issuerEn,
    issuedOn: licence.issuedOn,
    expiresOn: licence.expiresOn,
    isPrimary: licence.isPrimary,
    asset: toPublicAsset(licence.asset),
  };
}
