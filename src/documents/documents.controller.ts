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
import { DocCategory } from '../database/entities/doc-category.entity.js';
import { SafeerDocument } from '../database/entities/document.entity.js';
import { toPublicDocCategory, toPublicDocument, type PublicDocSection, type PublicDocumentGroup } from './public-document.js';

/**
 * The public documents register. Every route serves published categories
 * and published documents only, cached under `documents` (admin
 * doc-categories/documents writes purge it).
 */
@Controller('documents')
@SkipThrottle()
export class DocumentsController {
  constructor(
    @InjectRepository(DocCategory) private readonly categoryRepo: Repository<DocCategory>,
    @InjectRepository(SafeerDocument) private readonly documentRepo: Repository<SafeerDocument>,
  ) {}

  /** Every published category with its published documents, in order. */
  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('documents')
  @CacheKeyParams()
  async list(): Promise<PublicDocumentGroup[]> {
    const categories = await this.categoryRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC', id: 'ASC' } });
    if (categories.length === 0) return [];

    const documents = await this.documentRepo.find({
      where: categories.map((c) => ({ categoryId: c.id, isPublished: true })),
      order: { sortOrder: 'ASC', id: 'ASC' },
      relations: { asset: true },
    });
    const byCategory = new Map<string, SafeerDocument[]>();
    for (const doc of documents) {
      const bucket = byCategory.get(doc.categoryId);
      if (bucket) bucket.push(doc);
      else byCategory.set(doc.categoryId, [doc]);
    }
    return categories.map((category) => ({
      category: toPublicDocCategory(category),
      documents: (byCategory.get(category.id) ?? []).map(toPublicDocument),
    }));
  }

  /**
   * 022: the governance page's section list — published categories in the
   * `governance` group, in order, each with its number of published
   * documents (0 included, so the page can show an empty section).
   */
  @Public()
  @Get('sections')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('documents')
  @CacheKeyParams()
  async sections(): Promise<PublicDocSection[]> {
    const categories = await this.categoryRepo.find({
      where: { isPublished: true, sectionGroup: 'governance' },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    if (categories.length === 0) return [];

    const counts = await this.documentRepo
      .createQueryBuilder('d')
      .select('d.categoryId', 'categoryId')
      .addSelect('COUNT(*)', 'count')
      .where('d.isPublished = true')
      .andWhere('d.categoryId IN (:...ids)', { ids: categories.map((c) => c.id) })
      .groupBy('d.categoryId')
      .getRawMany<{ categoryId: string | number; count: string | number }>();
    const countBy = new Map(counts.map((r) => [String(r.categoryId), Number(r.count)]));

    return categories.map((category) => ({ ...toPublicDocCategory(category), count: countBy.get(category.id) ?? 0 }));
  }

  /** 022: one published category (any section group) with its published documents; 404 when missing or unpublished. */
  @Public()
  @Get('sections/:slug')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('documents')
  @CacheKeyParams()
  async section(@Param('slug') slug: string): Promise<PublicDocumentGroup> {
    const category = await this.categoryRepo.findOne({ where: { slug, isPublished: true } });
    if (!category) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');

    const documents = await this.documentRepo.find({
      where: { categoryId: category.id, isPublished: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
      relations: { asset: true },
    });
    return { category: toPublicDocCategory(category), documents: documents.map(toPublicDocument) };
  }
}
