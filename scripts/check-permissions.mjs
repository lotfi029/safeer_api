#!/usr/bin/env node
// scripts/check-permissions.mjs — CI gate (PERM-3, was check-admin-roles for
// B4/B5/B17): every admin/* route is gated by a catalog permission whose
// action matches its HTTP method, or is explicitly allow-listed.
// See scripts/lib/check-permissions.mjs for the actual check.
//
// Usage: npm run build && npm run check:permissions
// (needs a reachable, migrated database, like scripts/export-openapi.mjs —
// booting the full app requires TypeOrmModule to connect.)

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { findUngatedAdminRoutes } from './lib/check-permissions.mjs';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const violations = findUngatedAdminRoutes(app);
  await app.close();

  if (violations.length > 0) {
    console.error(`${violations.length} admin/* route(s) are not gated by a matching catalog permission:\n`);
    for (const v of violations) {
      console.error(`  ${v.controller}.${v.method} -> ${v.httpMethod} /${v.path}: ${v.problem}`);
    }
    console.error(
      '\nTag the handler with @Permission(...) from src/auth/decorators/permission.decorator.ts (a key from src/auth/permissions.ts, action matching the method), or add the exact route to the allow-list in scripts/lib/check-permissions.mjs if it is intentionally open to any signed-in staff member.',
    );
    process.exit(1);
  }

  console.log('Every admin/* route is gated by a catalog permission matching its method, or explicitly allow-listed.');
}

await main();
