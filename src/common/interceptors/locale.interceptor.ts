import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { isAdminRoute, type Locale, type RequestContext } from '../request-context.js';
import { asString } from '../query/list-params.js';

/**
 * 26-backend-code-review.md H2, a broader instance than the review names:
 * `req.query?.lang as string | undefined` is a compile-time-only assertion
 * — it does nothing at runtime, so a repeated `?lang=` key (which
 * `querystring.parse`, Express 5's default query parser, turns into an
 * array — see list-params.ts's header comment) reached `.toLowerCase()`
 * directly and threw. This interceptor is a global `APP_INTERCEPTOR`
 * (app.module.ts), so the crash was reachable on *every* route in the
 * app, admin and public alike, before any per-route guard (like
 * library-public.controller.ts's own `readString`) ever got a chance to
 * run — confirmed live: `?lang=a&lang=b` against any route threw here,
 * not in the route handler.
 */
function resolveLocale(req: RequestContext): Locale {
  const queryLang = asString(req.query?.lang)?.toLowerCase();
  if (queryLang === 'ar' || queryLang === 'en') return queryLang;

  const acceptLanguage = req.headers['accept-language'];
  if (typeof acceptLanguage === 'string') {
    const first = acceptLanguage.split(',')[0]?.trim().slice(0, 2).toLowerCase();
    if (first === 'en') return 'en';
  }
  return 'ar';
}

/**
 * A bilingual-pair base name (`title`) merges `titleAr`/`titleEn` when both
 * are present. Every entity in `src/database/entities` is camelCase (there
 * is no snake_case naming strategy configured on the TypeORM connection —
 * see database.module.ts), so the suffixes checked here are `Ar`/`En`, not
 * `_ar`/`_en`. Matching on a capitalised suffix is safe against false
 * positives: a field would have to end in a literal capital A/E immediately
 * followed by lowercase `r`/`n` to collide, which camelCase's word-boundary
 * capitalisation rules out for anything other than an intentional bilingual
 * pair.
 */
function collapseBilingual(value: unknown, locale: Locale): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => collapseBilingual(item, locale));
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    const mergeBases = new Set<string>();
    for (const key of keys) {
      if (key.endsWith('Ar') && keys.includes(`${key.slice(0, -2)}En`)) {
        mergeBases.add(key.slice(0, -2));
      }
    }

    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key.endsWith('Ar')) {
        const base = key.slice(0, -2);
        if (mergeBases.has(base)) {
          const enValue = obj[`${base}En`];
          const arValue = obj[key];
          // C39: a whitespace-only English value is blank too — it falls back to Arabic.
          const useEn = locale === 'en' && enValue !== null && enValue !== undefined && !(typeof enValue === 'string' && enValue.trim() === '');
          result[base] = useEn ? enValue : arValue;
          continue;
        }
      }
      if (key.endsWith('En')) {
        const base = key.slice(0, -2);
        if (mergeBases.has(base)) continue; // handled via the Ar branch above
      }
      result[key] = collapseBilingual(obj[key], locale);
    }
    return result;
  }

  return value;
}

/**
 * Resolves the active locale (`?lang=` → `Accept-Language` → `ar`) and
 * stashes it on the request for downstream handlers. On public responses it
 * collapses every `*_ar`/`*_en` pair into a bare field, falling back to
 * Arabic when English is blank; `/api/v1/admin/*` responses are left with
 * both raw columns untouched (11-architecture.md §3).
 */
@Injectable()
export class LocaleInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestContext>();
    const locale = resolveLocale(req);
    req.locale = locale;

    if (isAdminRoute(req.path)) {
      return next.handle();
    }

    return next.handle().pipe(map((data) => collapseBilingual(data, locale)));
  }
}
