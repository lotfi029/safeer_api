import type { Page } from '../database/entities/page.entity.js';
import type { PageSection } from '../database/entities/page-section.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

export interface PublicPageSection {
  id: string;
  sectionKey: string;
  labelAr: string | null;
  labelEn: string | null;
  headingAr: string | null;
  headingEn: string | null;
  bodyAr: string | null;
  bodyEn: string | null;
  primaryButtonLabelAr: string | null;
  primaryButtonLabelEn: string | null;
  primaryButtonUrl: string | null;
  secondaryButtonLabelAr: string | null;
  secondaryButtonLabelEn: string | null;
  secondaryButtonUrl: string | null;
  imageAsset: PublicMediaAsset | null;
  sortOrder: number;
}

export function toPublicPageSection(section: PageSection): PublicPageSection {
  return {
    id: section.id,
    sectionKey: section.sectionKey,
    labelAr: section.labelAr,
    labelEn: section.labelEn,
    headingAr: section.headingAr,
    headingEn: section.headingEn,
    bodyAr: section.bodyAr,
    bodyEn: section.bodyEn,
    primaryButtonLabelAr: section.primaryButtonLabelAr,
    primaryButtonLabelEn: section.primaryButtonLabelEn,
    primaryButtonUrl: section.primaryButtonUrl,
    secondaryButtonLabelAr: section.secondaryButtonLabelAr,
    secondaryButtonLabelEn: section.secondaryButtonLabelEn,
    secondaryButtonUrl: section.secondaryButtonUrl,
    imageAsset: toPublicAsset(section.imageAsset),
    sortOrder: section.sortOrder,
  };
}

export interface PublicPage {
  id: string;
  slug: string;
  titleAr: string;
  titleEn: string | null;
  metaTitleAr: string | null;
  metaTitleEn: string | null;
  metaDescriptionAr: string | null;
  metaDescriptionEn: string | null;
  sections: PublicPageSection[];
}

export function toPublicPage(page: Page, sections: PageSection[]): PublicPage {
  return {
    id: page.id,
    slug: page.slug,
    titleAr: page.titleAr,
    titleEn: page.titleEn,
    metaTitleAr: page.metaTitleAr,
    metaTitleEn: page.metaTitleEn,
    metaDescriptionAr: page.metaDescriptionAr,
    metaDescriptionEn: page.metaDescriptionEn,
    sections: sections.map(toPublicPageSection),
  };
}
