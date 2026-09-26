import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { MarkdownService } from '../common/markdown/markdown.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { readString } from '../common/query/list-params.js';
import { AboutItem, type AboutItemKind } from '../database/entities/about-item.entity.js';
import { toPublicAboutItem, type PublicAboutItem } from '../home/public-home.js';

export const ABOUT_ITEM_KINDS: readonly AboutItemKind[] = ['vision', 'mission', 'goal', 'care_pillar', 'scholarship_step', 'requirement'];

/** Parses `?kind=a,b` — every value must be a known kind (C42: an unknown value is a 400, never a cached empty result). */
export function parseKinds(raw: string | undefined): AboutItemKind[] {
  if (raw === undefined || raw.trim() === '') return [...ABOUT_ITEM_KINDS];
  const kinds = [...new Set(raw.split(',').map((k) => k.trim()))];
  const unknown = kinds.filter((k) => !ABOUT_ITEM_KINDS.includes(k as AboutItemKind));
  if (unknown.length > 0) {
    throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `Unknown about-item kind: ${unknown.join(', ')}`);
  }
  return kinds as AboutItemKind[];
}

/**
 * B18: `GET about-items?kind=vision,mission,…` — the published items of the
 * requested kinds (all kinds by default), grouped by kind and sorted by
 * `sortOrder`, bodies rendered to sanitized HTML (C26). The about and
 * scholarships pages build their cards and lists from it (their section
 * headings come from `GET pages/:slug`). Cached under `about_items`, the
 * tag every admin/about-items write purges.
 */
@Controller('about-items')
@SkipThrottle()
export class AboutItemsController {
  constructor(
    @InjectRepository(AboutItem) private readonly repo: Repository<AboutItem>,
    private readonly markdown: MarkdownService,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('about_items')
  @CacheKeyParams('kind')
  @ApiQuery({ name: 'kind', required: false, description: `Comma-separated: ${ABOUT_ITEM_KINDS.join(', ')}` })
  async list(@Query() query: Record<string, unknown>): Promise<Partial<Record<AboutItemKind, PublicAboutItem[]>>> {
    const kinds = parseKinds(readString(query, 'kind'));
    const rows = await this.repo.find({
      where: { kind: In(kinds), isPublished: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    const render = (md: string) => this.markdown.render(md);
    const grouped: Partial<Record<AboutItemKind, PublicAboutItem[]>> = {};
    for (const kind of kinds) grouped[kind] = [];
    for (const row of rows) grouped[row.kind]!.push(toPublicAboutItem(row, render));
    return grouped;
  }
}
