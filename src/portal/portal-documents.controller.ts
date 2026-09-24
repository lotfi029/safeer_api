import { Body, Controller, Delete, Get, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { PortalDocumentsService } from './portal-documents.service.js';
import { PrivateFileStore, MAX_PRIVATE_FILE_BYTES } from '../storage/private-file-store.service.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import type { RequestContext } from '../common/request-context.js';

@Controller('portal/documents')
@ApplicantRoute()
export class PortalDocumentsController {
  constructor(
    private readonly documentsService: PortalDocumentsService,
    private readonly fileStore: PrivateFileStore,
  ) {}

  @Get()
  async list(@Req() req: RequestContext) {
    const { documents, completeness } = await this.documentsService.list(req.applicant!.applicationId);
    return { documents, completeness };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PRIVATE_FILE_BYTES } }))
  upload(@UploadedFile() file: Express.Multer.File, @Body('docType') docType: string, @Req() req: RequestContext) {
    return this.documentsService.upload(req.applicant!.applicationId, docType, file);
  }

  @Get(':id/file')
  async streamFile(@Param('id') id: string, @Req() req: RequestContext, @Res() res: Response): Promise<void> {
    const doc = await this.documentsService.findOwned(req.applicant!.applicationId, id);

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

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext) {
    await this.documentsService.remove(req.applicant!.applicationId, id);
    return { deleted: true };
  }
}
