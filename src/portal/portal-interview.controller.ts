import { Body, Controller, Delete, Get, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PortalInterviewService } from './portal-interview.service.js';
import { BookInterviewDto } from './dto/book-interview.dto.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import type { RequestContext } from '../common/request-context.js';

/** A9: per IP, per route (book and cancel each), per hour. */
const INTERVIEW_CHANGES_PER_HOUR = 5;

@Controller('portal')
@ApplicantRoute()
export class PortalInterviewController {
  constructor(private readonly interviewService: PortalInterviewService) {}

  @Get('interview-slots')
  listSlots(@Req() req: RequestContext) {
    return this.interviewService.listOpenSlots(req.applicant!.applicationId);
  }

  /**
   * A9: booking and cancelling each send the applicant a mail and an SMS
   * (C17), so each is capped at INTERVIEW_CHANGES_PER_HOUR per IP — enough to
   * change one's mind a few times, not enough to run up the SMS bill.
   */
  @Post('interview')
  @Throttle({ default: { limit: INTERVIEW_CHANGES_PER_HOUR, ttl: 3_600_000 } })
  book(@Body() dto: BookInterviewDto, @Req() req: RequestContext) {
    return this.interviewService.book(req.applicant!.applicationId, dto.slotId);
  }

  /** C17: cancel the booked interview (to choose another time). */
  @Delete('interview')
  @Throttle({ default: { limit: INTERVIEW_CHANGES_PER_HOUR, ttl: 3_600_000 } })
  cancel(@Req() req: RequestContext) {
    return this.interviewService.cancel(req.applicant!.applicationId);
  }
}
