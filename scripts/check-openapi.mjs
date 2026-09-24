#!/usr/bin/env node
// scripts/check-openapi.mjs — CI guard. Regenerates the OpenAPI document in
// memory and diffs it against the committed openapi.json, failing the
// build if they differ. A stale contract is exactly what
// export-openapi.mjs's own header warns about, and any generated frontend
// API client is built from this file.
//
// Same prerequisites as export-openapi.mjs: `npm run build` first, and a
// reachable, migrated database (boots the full Nest app, never listens).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from '../dist/app.module.js';
import { loadEnv } from '../dist/config/env.js';
import { buildSwaggerConfig, fixNullableStringSchemas } from '../dist/swagger.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const committedPath = path.join(__dirname, '..', 'openapi.json');

async function main() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  const raw = SwaggerModule.createDocument(app, buildSwaggerConfig(env));
  const fresh = JSON.stringify(cleanupOpenApiDoc(fixNullableStringSchemas(raw)), null, 2) + '\n';
  await app.close();

  const committed = await readFile(committedPath, 'utf8').catch(() => null);

  if (committed === fresh) {
    console.log('openapi.json is up to date.');
    return;
  }

  console.error(
    'openapi.json is stale — it no longer matches what the API actually serves.\n' +
      'Run `npm run build && npm run openapi`, then commit the result.',
  );
  process.exitCode = 1;
}

await main();
