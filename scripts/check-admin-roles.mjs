#!/usr/bin/env node
// scripts/check-admin-roles.mjs — CI gate for B4/B5 (safeer-backend-fr-review.md):
// every admin/* route must be role-gated (or explicitly allow-listed).
// See scripts/lib/check-admin-roles.mjs for the actual check.
//
// Usage: npm run build && npm run check:admin-roles
// (needs a reachable, migrated database, like scripts/export-openapi.mjs —
// booting the full app requires TypeOrmModule to connect.)

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { findUnroledAdminRoutes } from './lib/check-admin-roles.mjs';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const violations = findUnroledAdminRoutes(app);
  await app.close();

  if (violations.length > 0) {
    console.error(`${violations.length} admin/* route(s) have no @Roles() and are not allow-listed:\n`);
    for (const v of violations) {
      console.error(`  ${v.controller}.${v.method} -> /${v.path}`);
    }
    console.error('\nAdd @Roles(...) (class- or method-level), or add the exact route to the allow-list in scripts/lib/check-admin-roles.mjs if it is intentionally open to any signed-in staff member.');
    process.exit(1);
  }

  console.log('Every admin/* route is role-gated or explicitly allow-listed.');
}

await main();
