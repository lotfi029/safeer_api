import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { PrivateFileStore } from '../storage/private-file-store.service.js';
import { AdminApplicationsService } from './admin-applications.service.js';
import { UpdateApplicationAdminDto } from './dto/update-application.dto.js';
import { RequestDocumentsDto } from './dto/request-documents.dto.js';
import { ReviewDocumentDto } from './dto/review-document.dto.js';
import { CreateApplicationNoteDto } from './dto/create-note.dto.js';
import { BulkActionDto } from './dto/bulk-action.dto.js';

/**
 * `admin/applications` — the caseworker/reviewer surface for the scholarship
 * pipeline (project plan "Applications"). Hand-written, like
 * `AdminMessagesController`, since none of this is `CrudController`-shaped:
 * a status-transition map, document accept/reject, bulk actions and a CSV
 * export all need custom handlers.
 *
 * Route order matters: `counts` and `export.csv` are registered before
 * `:id` so Express doesn't swallow them as an id segment (the same
 * discipline `crud.factory.ts` documents for its own `reorder`/`:id` split).
 */
@Controller('admin/applications')
@Roles('admin', 'reviewer')
@ApiCookieAuth()
export class AdminApplicationsController {
  constructor(
    private readonly applications: AdminApplicationsService,
    private readonly fileStore: PrivateFileStore,
  ) {}

  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'reviewerId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    return this.applications.list(query);
  }

  @Get('counts')
  async counts() {
    return this.applications.counts();
  }

  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'reviewerId', required: false, type: String })
  @Get('export.csv')
  async exportCsv(@Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const csv = await this.applications.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="applications.csv"');
    res.send(csv);
  }

  @Post('bulk')
  async bulk(@Body() dto: BulkActionDto, @Req() req: RequestContext) {
    return this.applications.bulkAction(dto, req);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.applications.getDetail(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateApplicationAdminDto, @Req() req: RequestContext) {
    return this.applications.updateApplication(id, dto, req);
  }

  @Post(':id/request-documents')
  async requestDocuments(@Param('id') id: string, @Body() dto: RequestDocumentsDto, @Req() req: RequestContext) {
    return this.applications.requestDocumentsForOne(id, dto.docTypes, dto.message ?? null, req);
  }

  @Patch(':id/documents/:docId')
  async reviewDocument(@Param('id') id: string, @Param('docId') docId: string, @Body() dto: ReviewDocumentDto, @Req() req: RequestContext) {
    return this.applications.reviewDocument(id, docId, dto, req);
  }

  /** Role-gated (class-level), not ownership-gated — the applicant's own copy of this route is `portal/documents/:id/file`. */
  @Get(':id/documents/:docId/file')
  async streamDocument(@Param('id') id: string, @Param('docId') docId: string, @Res() res: Response): Promise<void> {
    const doc = await this.applications.getDocumentForStream(id, docId);

    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName.replace(/"/g, '')}"`);

    const stream = createReadStream(this.fileStore.resolvePath(doc.storageKey));
    stream.on('error', () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
  }

  @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body() dto: CreateApplicationNoteDto, @Req() req: RequestContext) {
    return this.applications.addNote(id, dto.body, req);
  }
}
