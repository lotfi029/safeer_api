import type { Partner, PartnerCategory } from '../database/entities/partner.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

export interface PublicPartner {
  id: string;
  nameAr: string;
  nameEn: string | null;
  category: PartnerCategory;
  url: string | null;
  logoAsset: PublicMediaAsset | null;
  sortOrder: number;
}

export function toPublicPartner(partner: Partner): PublicPartner {
  return {
    id: partner.id,
    nameAr: partner.nameAr,
    nameEn: partner.nameEn,
    category: partner.category,
    url: partner.url,
    logoAsset: toPublicAsset(partner.logoAsset),
    sortOrder: partner.sortOrder,
  };
}
