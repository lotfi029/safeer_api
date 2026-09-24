import { DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import type { Env } from './config/env.js';

/**
 * Shared by `main.ts` (serves it live at `/api/docs`) and
 * `scripts/export-openapi.mjs` (writes it to the committed `openapi.json`,
 * C7.1) — one definition, so the two can't drift apart.
 */
export function buildSwaggerConfig(env: Pick<Env, 'SESSION_COOKIE_NAME'>) {
  return new DocumentBuilder()
    .setTitle('Safeer API')
    .setDescription('جمعية سفير الدعوية / Safeer Association — content and admin API')
    .setVersion('1.0')
    .addCookieAuth(env.SESSION_COOKIE_NAME)
    // B3-1: main.ts's setGlobalPrefix('api/v1') was never reflected here —
    // `servers` was `[]`, so every path in openapi.json was missing the
    // prefix it actually needs (e.g. `/admin/auth/login` instead of
    // `/api/v1/admin/auth/login`). Any client generated from the file was
    // silently wrong.
    .addServer('/api/v1')
    .build();
}

/**
 * B3-1: works around a genuine bug in nestjs-zod 5.5.0 (the latest
 * published version at the time of this fix — confirmed no newer one
 * exists), not something an application can configure its way out of.
 *
 * Verified directly, isolated from this codebase's DTOs: *any* nullable
 * property — `.nullable()`, `.nullable().optional()`, or even a
 * hand-written `z.union([z.string(), z.null()])` — is converted to
 * `{ type: 'array', items: { type: 'string' } }` by nestjs-zod's schema
 * factory, regardless of `DocumentBuilder.setOpenAPIVersion()` and
 * regardless of running nestjs-zod's own documented `cleanupOpenApiDoc()`
 * post-processor afterward (which strips the diagnostic marker below but
 * does not touch the wrong `type`/`items`, in either OpenAPI 3.0 or 3.1
 * mode). nestjs-zod's README describes the exact opposite of this
 * behaviour, so this is a version-specific regression, not intended
 * design — re-check whether a newer nestjs-zod release fixes it properly
 * before assuming this workaround is still needed.
 *
 * Every properly-nullable field nestjs-zod produces this way carries its
 * own `x-nestjs_zod-empty-type: true` marker (confirmed against the whole
 * committed document: every array-of-string property has the marker, and
 * no property with the marker is a real array), so detecting "marker +
 * array-of-string shape" has no false positives here. Every one of them is
 * a nullable *string* in this schema (there are no nullable numbers or
 * booleans in any DTO), so rewriting straight to a 3.0-style
 * `{ type: 'string', nullable: true }` is correct for this codebase
 * without needing to handle other nullable primitive types generically.
 */
export function fixNullableStringSchemas(document: OpenAPIObject): OpenAPIObject {
  for (const schema of Object.values(document.components?.schemas ?? {})) {
    if (typeof schema !== 'object' || !('properties' in schema) || !schema.properties) continue;
    for (const prop of Object.values(schema.properties) as Record<string, unknown>[]) {
      if (
        prop['x-nestjs_zod-empty-type'] === true &&
        prop.type === 'array' &&
        typeof prop.items === 'object' &&
        prop.items !== null &&
        (prop.items as Record<string, unknown>).type === 'string'
      ) {
        delete prop['x-nestjs_zod-empty-type'];
        delete prop.items;
        prop.type = 'string';
        prop.nullable = true;
      }
    }
  }
  return document;
}
