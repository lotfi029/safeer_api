import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { DocCategory } from '../database/entities/doc-category.entity.js';
import { SafeerDocument } from '../database/entities/document.entity.js';
import { toPublicDocCategory, toPublicDocument, type PublicDocumentGroup } from './public-document.js';

@Controller('documents')
@SkipThrottle()
export class DocumentsController {
  constructor(
    @InjectRepository(DocCategory) private readonly categoryRepo: Repository<DocCategory>,
    @InjectRepository(SafeerDocument) private readonly documentRepo: Repository<SafeerDocument>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('documents')
  @CacheKeyParams()
  async list(): Promise<PublicDocumentGroup[]> {
    const categories = await this.categoryRepo.find({ where: { isPublished: true }, order: { sortOrder: 'ASC' } });
    if (categories.length === 0) return [];

    const documents = await this.documentRepo.find({
      where: categories.map((c) => ({ categoryId: c.id, isPublished: true })),
      order: { sortOrder: 'ASC' },
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
}
