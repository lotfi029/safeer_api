import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import { loadEnv, corsOrigins } from './config/env.js';
import { buildSwaggerConfig, fixNullableStringSchemas } from './swagger.config.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { requestIdMiddleware } from './common/request-id.middleware.js';
import { ipHashMiddleware } from './common/ip-hash.middleware.js';
import { RedactingJsonLogger } from './common/logging/redacting-json-logger.js';

async function bootstrap() {
  const env = loadEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // B2/NFR-11: structured JSON logs with a redaction pass, in production
    // only — a log aggregator wants JSON lines; a developer at a terminal
    // wants the default's colored, human-readable format. See
    // redacting-json-logger.ts for exactly what's redacted and why.
    logger: env.NODE_ENV === 'production' ? new RedactingJsonLogger() : undefined,
  });

  // Deployed behind Nginx (11-architecture.md §7); without this, req.ip is
  // the proxy's address and every ip_hash column records the same value for
  // every visitor.
  app.set('trust proxy', 1);

  app.use(requestIdMiddleware);
  app.use(ipHashMiddleware(env.IP_HASH_SALT));

  // Strict CSP. Unlike african_api, Safeer has no oEmbed-style external
  // media (no library/YouTube/SoundCloud/Spotify module), so frame-src has
  // no external allow-list — img-src stays 'self' because every asset is
  // served from our own /files route, never hot-linked.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameSrc: ["'none'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
    // C36: the dashboard reads it to warn that an export was capped.
    exposedHeaders: ['X-Truncated'],
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      // /files/* is intentionally outside the versioned API (11-architecture.md §3).
      { path: 'files/:publicId', method: RequestMethod.GET },
      { path: 'files/:publicId/:variant', method: RequestMethod.GET },
    ],
  });

  // Every zod DTO built with createZodDto() is validated here; DTOs use
  // .strict() so unknown fields are rejected (11-architecture.md §3).
  app.useGlobalPipes(new ZodValidationPipe());

  app.useGlobalFilters(new HttpExceptionFilter());

  // B0-2: Swagger's Express routes are registered outside Nest's guard
  // pipeline, so SessionGuard never covers them — mounting this
  // unconditionally published the full admin surface (invite, reset,
  // mail-settings shapes) at /api/docs in every environment, including
  // production. Gating it behind the session cookie instead would be worse:
  // the strict CSP above (no 'unsafe-inline') already breaks Swagger UI's
  // inline bootstrap script, so an authenticated /api/docs in production
  // would just be a blank page that still serves the underlying JSON.
  // scripts/export-openapi.mjs builds its own document directly and never
  // goes through this file, so npm run openapi is unaffected.
  if (env.NODE_ENV !== 'production') {
    const raw = SwaggerModule.createDocument(app, buildSwaggerConfig(env));
    // B3-1: fixNullableStringSchemas() must run before cleanupOpenApiDoc()
    // — the latter is nestjs-zod's own required post-processor (strips
    // internal x-nestjs_zod-* markers it uses to carry metadata through
    // schema generation) but it strips the empty-type marker without
    // fixing the array-of-string shape it was recording, so this repairs
    // that first while the marker is still there to detect it by.
    const document = cleanupOpenApiDoc(fixNullableStringSchemas(raw));
    SwaggerModule.setup('api/docs', app, document);
  } else {
    Logger.log('Swagger UI disabled (NODE_ENV=production)', 'Bootstrap');
  }

  // A4: on SIGTERM/SIGINT (a PM2 restart, a redeploy) Nest runs its
  // shutdown hooks before exiting, so BackgroundWork can finish sends that
  // public routes answered before (request-otp). ecosystem.config.cjs gives
  // it kill_timeout: 12000 to do so.
  app.enableShutdownHooks();

  await app.listen(env.PORT);
}

// Not a top-level `await bootstrap()`: Hostinger's Node.js hosting runs the
// app under LiteSpeed, whose /usr/local/lsws/fcgi-bin/lsnode.js `require()`s
// this file. Node can require() an ESM graph, but not one containing a
// top-level await — it throws ERR_REQUIRE_ASYNC_MODULE before a single line
// of bootstrap() runs, and the only symptom is a 503 with that error in the
// runtime log. Calling it and catching keeps the same crash-on-failure
// behaviour (loadEnv already process.exit(1)s on a bad env) without putting
// an await in the module graph. Do not 'simplify' this back.
bootstrap().catch((err: unknown) => {
  Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'Bootstrap');
  process.exit(1);
});
