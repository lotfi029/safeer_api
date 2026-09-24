import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SafeerDocument } from '../database/entities/document.entity.js';
import { createDocumentSchema, updateDocumentSchema } from './dto/document.dto.js';

/** `?categoryId=` filters for free via the kernel's automatic exact-match query filter. */
@Controller('admin/documents')
@Roles('admin', 'editor')
export class AdminDocumentsController extends CrudController<SafeerDocument>({
  path: 'admin/documents',
  entity: SafeerDocument,
  createDto: createDocumentSchema,
  updateDto: updateDocumentSchema,
  publishable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['documents', 'home'],
  label: (d) => d.titleAr,
}) {}
