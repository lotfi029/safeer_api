import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SiteSettings } from '../database/entities/site-settings.entity.js';
import { Stat } from '../database/entities/stat.entity.js';
import { AboutItem } from '../database/entities/about-item.entity.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Testimonial } from '../database/entities/testimonial.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { toPublicSiteSettings, type PublicSiteSettings } from '../site-settings/public-site-settings.js';
import { toPublicPageSection, type PublicPageSection } from '../pages/public-page.js';
import { toPublicStat, toPublicAboutItem, type PublicStat, type PublicAboutItem } from './public-home.js';
import { toPublicWorkArea, type PublicWorkArea } from '../work-areas/public-work-area.js';
import { toPublicPostSummary, type PublicPostSummary } from '../news/public-post.js';
import { toPublicTestimonial, type PublicTestimonial } from '../testimonials/public-testimonial.js';
import { toPublicPartner, type PublicPartner } from '../partners/public-partner.js';
import { MarkdownService } from '../common/markdown/markdown.service.js';

const HOME_PAGE_SLUG = 'home';
const NEWS_LATEST = 3;
const TESTIMONIALS_LATEST = 2;

export interface PublicHome {
  settings: PublicSiteSettings | null;
  sections: PublicPageSection[];
  aboutItems: {
    goals: PublicAboutItem[];
    carePillars: PublicAboutItem[];
  };
  stats: PublicStat[];
  workAreas: PublicWorkArea[];
  news: PublicPostSummary[];
  testimonials: PublicTestimonial[];
  partners: PublicPartner[];
}

@Injectable()
export class HomeService {
  constructor(
    @InjectRepository(SiteSettings) private readonly settingsRepo: Repository<SiteSettings>,
    @InjectRepository(Stat) private readonly statsRepo: Repository<Stat>,
    @InjectRepository(AboutItem) private readonly aboutRepo: Repository<AboutItem>,
    @InjectRepository(WorkArea) private readonly workAreaRepo: Repository<WorkArea>,
    @InjectRepository(WorkAreaItem) private readonly workAreaItemRepo: Repository<WorkAreaItem>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Testimonial) private readonly testimonialRepo: Repository<Testimonial>,
    @InjectRepository(Partner) private readonly partnerRepo: Repository<Partner>,
    @InjectRepository(PageSection) private readonly sectionRepo: Repository<PageSection>,
    private readonly markdown: MarkdownService,
  ) {}

  /**
   * One aggregate for the home screen (project plan's "Modules and routes"
   * table). `sections` is the home page's own visible, ordered
   * `page_sections` rows — joined to `pages` on `slug = 'home'` in one query
   * rather than fetching the page row first, so it can run inside the same
   * `Promise.all` as everything else. Note that `partners` here reflects the
   * `partners` table's own `is_published` flag, independent of whether the
   * home page's own `partners` *section* (in `sections`, above) is currently
   * shown — the seed hides that section (prototype's home screen doesn't
   * render a partner strip yet) while still seeding real, published partner
   * rows for the dedicated `/partners` page; a caller wanting to know
   * whether to render the partners block on the home screen itself should
   * check `sections` for `sectionKey: 'partners'`, not whether this array is
   * empty.
   */
  async getHome(): Promise<PublicHome> {
    const [settings, sections, goals, carePillars, stats, workAreas, latestPosts, testimonials, partners] = await Promise.all([
      this.settingsRepo.findOne({ where: { id: '1' } }),
      this.sectionRepo
        .createQueryBuilder('s')
        .innerJoin('s.page', 'p')
        .leftJoinAndSelect('s.imageAsset', 'asset')
        .where('p.slug = :slug', { slug: HOME_PAGE_SLUG })
        .andWhere('p.isPublished = true')
        .andWhere('s.isPublished = true')
        .orderBy('s.sortOrder', 'ASC')
        .getMany(),
      this.aboutRepo.find({ where: { kind: 'goal', isPublished: true }, order: { sortOrder: 'ASC' } }),
      this.aboutRepo.find({ where: { kind: 'care_pillar', isPublished: true }, order: { sortOrder: 'ASC' } }),
      this.statsRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC' } }),
      this.workAreaRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC' } }),
      this.postRepo.find({
        where: { isPublished: true },
        order: { publishedOn: 'DESC' },
        take: NEWS_LATEST,
        relations: { category: true, coverAsset: true },
      }),
      this.testimonialRepo.find({
        where: { status: 'published' },
        order: { isFeatured: 'DESC', sortOrder: 'ASC' },
        take: TESTIMONIALS_LATEST,
      }),
      this.partnerRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC' }, relations: { logoAsset: true } }),
    ]);

    const workAreaItems = workAreas.length
      ? await this.workAreaItemRepo.find({
          // B11 (safeer-backend-fr-review.md)
          where: workAreas.map((a) => ({ workAreaId: a.id, isPublished: true })),
          order: { sortOrder: 'ASC' },
        })
      : [];
    const itemsByArea = new Map<string, typeof workAreaItems>();
    for (const item of workAreaItems) {
      const bucket = itemsByArea.get(item.workAreaId);
      if (bucket) bucket.push(item);
      else itemsByArea.set(item.workAreaId, [item]);
    }

    const render = (md: string) => this.markdown.render(md); // C26

    return {
      // `settings` is only null if 002_seed.sql's singleton row was never
      // applied — site-settings.controller.ts throws a genuine 500 on the
      // admin side for the same case.
      settings: settings ? toPublicSiteSettings(settings) : null,
      sections: sections.map((s) => toPublicPageSection(s, render)),
      aboutItems: {
        goals: goals.map((i) => toPublicAboutItem(i, render)),
        carePillars: carePillars.map((i) => toPublicAboutItem(i, render)),
      },
      stats: stats.map(toPublicStat),
      workAreas: workAreas.map((area) => toPublicWorkArea(area, itemsByArea.get(area.id) ?? [])),
      news: latestPosts.map(toPublicPostSummary),
      testimonials: testimonials.map(toPublicTestimonial),
      partners: partners.map(toPublicPartner),
    };
  }
}
