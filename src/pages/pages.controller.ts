import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { Page } from '../database/entities/page.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { toPublicPage, type PublicPage } from './public-page.js';
import { MarkdownService } from '../common/markdown/markdown.service.js';

/** Public read side of admin/pages + admin/page-sections. */
@Controller('pages')
@SkipThrottle()
export class PagesController {
  constructor(
    @InjectRepository(Page) private readonly pageRepo: Repository<Page>,
    @InjectRepository(PageSection) private readonly sectionRepo: Repository<PageSection>,
    private readonly markdown: MarkdownService,
  ) {}

  @Public()
  @Get(':slug')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('pages')
  @CacheKeyParams()
  async bySlug(@Param('slug') slug: string): Promise<PublicPage> {
    const page = await this.pageRepo.findOne({ where: { slug, isPublished: true } });
    if (!page) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');

    const sections = await this.sectionRepo.find({
      where: { pageId: page.id, isPublished: true },
      order: { sortOrder: 'ASC' },
      relations: { imageAsset: true },
    });
    return toPublicPage(page, sections, (md) => this.markdown.render(md));
  }
}
