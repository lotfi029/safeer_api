import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { toPublicSiteSettings, type PublicSiteSettings } from '../site-settings/public-site-settings.js';

/**
 * The prototype's primary nav order (`NAV` in the prototype's site-chrome
 * script block) — a fixed, hand-maintained list rather than a DB `sort_order`
 * column on `pages` (which has none): the nav's shape is a frontend routing
 * concern, not editorial content, and it changes only when a whole new
 * top-level screen is added to the site, not through the CMS. `article` is
 * deliberately excluded — it's the news-detail template page (`/pages/article`
 * exists only for its meta title/description), never a nav destination.
 */
const NAV_SLUGS = ['home', 'about', 'board', 'work', 'scholarships', 'news', 'testimonials', 'partners', 'documents', 'contact'] as const;

export interface PublicNavItem {
  slug: string;
  labelAr: string;
  labelEn: string | null;
}

export interface PublicSite {
  settings: PublicSiteSettings | null;
  nav: PublicNavItem[];
  contact: {
    phone: string | null;
    email: string | null;
    addressAr: string | null;
    addressEn: string | null;
  };
}

/**
 * Chrome shared by every public page — nav, footer, contact strip — kept
 * separate from `admin/settings` (site-settings.controller.ts, phase 2),
 * which stays the read/write admin side of the same `site_settings` table.
 */
@Controller('site')
@SkipThrottle()
export class SiteController {
  constructor(
    @InjectRepository(SiteSettings) private readonly settingsRepo: Repository<SiteSettings>,
    @InjectRepository(Page) private readonly pageRepo: Repository<Page>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  // 'pages' too: the nav is built from published pages, so publishing or
  // unpublishing one must purge this response, not only a settings edit.
  @CacheTags('site_settings', 'pages')
  @CacheKeyParams()
  async get(): Promise<PublicSite> {
    const [settings, pages] = await Promise.all([
      this.settingsRepo.findOne({ where: { id: '1' } }),
      this.pageRepo.find({ where: { isPublished: true } }),
    ]);

    const pagesBySlug = new Map(pages.map((p) => [p.slug, p]));
    const nav: PublicNavItem[] = [];
    for (const slug of NAV_SLUGS) {
      const page = pagesBySlug.get(slug);
      if (page) nav.push({ slug: page.slug, labelAr: page.titleAr, labelEn: page.titleEn });
    }

    return {
      settings: settings ? toPublicSiteSettings(settings) : null,
      nav,
      contact: settings
        ? { phone: settings.phone, email: settings.email, addressAr: settings.addressAr, addressEn: settings.addressEn }
        : { phone: null, email: null, addressAr: null, addressEn: null },
    };
  }
}
