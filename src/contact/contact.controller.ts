import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { ContactService } from './contact.service.js';
import { ContactDto, NewsletterDto } from './dto/contact.dto.js';

@Controller()
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 3/hour/IP
  @Post('contact')
  submit(@Body() dto: ContactDto, @Req() req: RequestContext) {
    const userAgent = req.headers['user-agent'];
    return this.contactService.submit(dto, req.ipHash ?? null, typeof userAgent === 'string' ? userAgent : null, req.locale);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } }) // 5/hour/IP
  @Post('newsletter')
  subscribe(@Body() dto: NewsletterDto, @Req() req: RequestContext) {
    return this.contactService.subscribe(dto, req.ipHash ?? null, req.locale);
  }
}
