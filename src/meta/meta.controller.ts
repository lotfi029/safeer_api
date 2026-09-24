import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { declarePurger } from '../cache/cache-tag-registry.js';
import { COUNTRIES, type MetaCountry } from './data/countries.js';

interface EnumOption {
  value: string;
  labelAr: string;
  labelEn: string;
}

/**
 * ar/en labels for every enum a public form (the apply flow, contact) needs
 * to render as a dropdown — values pulled straight from the phase-2 entity
 * `enum: [...]` lists (application.entity.ts, application-document.entity.ts
 * has no public form use, partner.entity.ts, contact-message.entity.ts) so
 * this can never drift from what the database actually accepts.
 */
const APPLICATION_STATUS: EnumOption[] = [
  { value: 'draft', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'new', labelAr: 'جديد', labelEn: 'New' },
  { value: 'under_review', labelAr: 'قيد المراجعة', labelEn: 'Under review' },
  { value: 'docs_missing', labelAr: 'مستندات ناقصة', labelEn: 'Documents missing' },
  { value: 'interview', labelAr: 'مقابلة', labelEn: 'Interview' },
  { value: 'accepted', labelAr: 'مقبول', labelEn: 'Accepted' },
  { value: 'rejected', labelAr: 'مرفوض', labelEn: 'Rejected' },
];

const DEGREE_LEVEL: EnumOption[] = [
  { value: 'bachelor', labelAr: 'بكالوريوس', labelEn: 'Bachelor' },
  { value: 'master', labelAr: 'ماجستير', labelEn: 'Master' },
  { value: 'phd', labelAr: 'دكتوراه', labelEn: 'PhD' },
];

const GENDER: EnumOption[] = [
  { value: 'male', labelAr: 'ذكر', labelEn: 'Male' },
  { value: 'female', labelAr: 'أنثى', labelEn: 'Female' },
];

const PARTNER_CATEGORY: EnumOption[] = [
  { value: 'government', labelAr: 'جهة حكومية', labelEn: 'Government' },
  { value: 'university', labelAr: 'جامعة', labelEn: 'University' },
  { value: 'association', labelAr: 'جمعية', labelEn: 'Association' },
  { value: 'supporter', labelAr: 'داعم', labelEn: 'Supporter' },
];

const CONTACT_SUBJECT: EnumOption[] = [
  { value: 'scholarship', labelAr: 'المنح الدراسية', labelEn: 'Scholarships' },
  { value: 'partnership', labelAr: 'الشراكات', labelEn: 'Partnership' },
  { value: 'feedback', labelAr: 'ملاحظات', labelEn: 'Feedback' },
  { value: 'other', labelAr: 'أخرى', labelEn: 'Other' },
];

/**
 * Static reference data every public form reads — never DB-backed, so it is
 * served straight from an in-memory constant/JSON file rather than a
 * collection with its own cache tag. Still routed through the same
 * `CacheInterceptor` as every other public GET so a CDN/`Cache-Control`
 * header is present, but declares its own `meta` tag with a no-op purger
 * (nothing ever writes to it) purely so `CacheTagAssertion` has a purger to
 * find — see cache-tag-registry.ts.
 */
@Controller('meta')
@SkipThrottle()
export class MetaController {
  constructor() {
    declarePurger('meta');
  }

  @Public()
  @Get('countries')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('meta')
  @CacheKeyParams()
  countries(): MetaCountry[] {
    return COUNTRIES;
  }

  @Public()
  @Get('enums')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('meta')
  @CacheKeyParams()
  enums(): Record<string, EnumOption[]> {
    return {
      applicationStatus: APPLICATION_STATUS,
      degreeLevel: DEGREE_LEVEL,
      gender: GENDER,
      partnerCategory: PARTNER_CATEGORY,
      contactSubject: CONTACT_SUBJECT,
    };
  }
}
