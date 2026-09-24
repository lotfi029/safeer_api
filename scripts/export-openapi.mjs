#!/usr/bin/env node
// scripts/export-openapi.mjs — writes the live Swagger document to the
// committed openapi.json (18-completion-plan.md C7.1), so the Angular client
// generates from a real, checked-in contract instead of a hand-typed guess.
//
// Regenerate this on every API change — a stale committed file is worse than
// none:
//   npm run build && npm run openapi
//
// Boots the full Nest app (needs a reachable, migrated database — same as
// `npm run start`) but never calls `.listen()`.

import { writeFile } from 'node:fs/promises';
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
const outPath = path.join(__dirname, '..', 'openapi.json');

async function main() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  const raw = SwaggerModule.createDocument(app, buildSwaggerConfig(env));
  // B3-1: same two-step fix as main.ts's live /api/docs — see
  // swagger.config.ts's fixNullableStringSchemas() for why both steps
  // (and this order) are needed.
  const document = cleanupOpenApiDoc(fixNullableStringSchemas(raw));
  await writeFile(outPath, JSON.stringify(document, null, 2) + '\n');
  await app.close();
  console.log(`Wrote ${outPath}`);
}

await main();
