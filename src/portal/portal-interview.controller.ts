import { Body, Controller, Delete, Get, Post, Req } from '@nestjs/common';
import { PortalInterviewService } from './portal-interview.service.js';
import { BookInterviewDto } from './dto/book-interview.dto.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import type { RequestContext } from '../common/request-context.js';

@Controller('portal')
@ApplicantRoute()
export class PortalInterviewController {
  constructor(private readonly interviewService: PortalInterviewService) {}

  @Get('interview-slots')
  listSlots(@Req() req: RequestContext) {
    return this.interviewService.listOpenSlots(req.applicant!.applicationId);
  }

  @Post('interview')
  book(@Body() dto: BookInterviewDto, @Req() req: RequestContext) {
    return this.interviewService.book(req.applicant!.applicationId, dto.slotId);
  }

  /** C17: cancel the booked interview (to choose another time). */
  @Delete('interview')
  cancel(@Req() req: RequestContext) {
    return this.interviewService.cancel(req.applicant!.applicationId);
  }
}
