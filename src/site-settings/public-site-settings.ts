import type { SiteSettings } from '../database/entities/site-settings.entity.js';

/**
 * The subset of `SiteSettings` safe to serve to anonymous visitors — shared
 * by `GET /home` and `GET /site` so the two aggregates never drift on what
 * "public settings" means. Drops `notifyEmailOnStatusChange`/
 * `notifySmsOnStatusChange` (internal ops toggles), `applicationRefPrefix`
 * (an internal numbering detail), and `updatedBy`/`updatedAt` (an admin
 * audit trail), none of which the public site reads or should see.
 */
export interface PublicSiteSettings {
  id: string;
  orgNameAr: string;
  orgNameEn: string | null;
  taglineAr: string | null;
  taglineEn: string | null;
  footerBlurbAr: string | null;
  footerBlurbEn: string | null;
  rightsLineAr: string | null;
  rightsLineEn: string | null;
  phone: string | null;
  email: string | null;
  addressAr: string | null;
  addressEn: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  xUrl: string | null;
  enEnabled: boolean;
  seoTitleAr: string | null;
  seoTitleEn: string | null;
  seoDescriptionAr: string | null;
  seoDescriptionEn: string | null;
}

export function toPublicSiteSettings(settings: SiteSettings): PublicSiteSettings {
  return {
    id: settings.id,
    orgNameAr: settings.orgNameAr,
    orgNameEn: settings.orgNameEn,
    taglineAr: settings.taglineAr,
    taglineEn: settings.taglineEn,
    footerBlurbAr: settings.footerBlurbAr,
    footerBlurbEn: settings.footerBlurbEn,
    rightsLineAr: settings.rightsLineAr,
    rightsLineEn: settings.rightsLineEn,
    phone: settings.phone,
    email: settings.email,
    addressAr: settings.addressAr,
    addressEn: settings.addressEn,
    facebookUrl: settings.facebookUrl,
    instagramUrl: settings.instagramUrl,
    xUrl: settings.xUrl,
    enEnabled: settings.enEnabled,
    seoTitleAr: settings.seoTitleAr,
    seoTitleEn: settings.seoTitleEn,
    seoDescriptionAr: settings.seoDescriptionAr,
    seoDescriptionEn: settings.seoDescriptionEn,
  };
}
