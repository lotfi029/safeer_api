import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { DocCategory } from '../database/entities/doc-category.entity.js';
import { SafeerDocument } from '../database/entities/document.entity.js';
import { DocumentsController } from './documents.controller.js';
import { AdminDocCategoriesController } from './admin-doc-categories.controller.js';
import { AdminDocumentsController } from './admin-documents.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([DocCategory, SafeerDocument]), CacheModule],
  controllers: [DocumentsController, AdminDocCategoriesController, AdminDocumentsController],
})
export class DocumentsModule {}
