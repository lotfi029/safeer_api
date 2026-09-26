import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { Area } from '../auth/role-matrix.js';
import { asString, readPageLimit } from '../common/query/list-params.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// B0-4: the whole controller is one read exposing ip_hash and full
// before/after diffs across every user's actions — there is no
// editor-appropriate subset, so this is class-level admin-only, matching
// users.controller.ts.
@Controller('admin/audit')
@Area('audit')
@ApiCookieAuth()
export class AuditController {
  constructor(@InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>) {}

  // B3-1: `@Query('name') x?: string` gives @nestjs/swagger just enough to
  // document the parameter's name and location, but not its optionality
  // (that's compile-time-only TS info, erased before a decorator ever
  // runs) — it defaulted every one of these to `required: true`, which
  // would make a generated client refuse to call this route without
  // arguments it doesn't need. Explicit @ApiQuery() states the truth.
  @ApiQuery({ name: 'entity', required: false, type: String })
  @ApiQuery({ name: 'actor', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Get()
  async list(
    @Query('entity') entityRaw?: unknown,
    @Query('actor') actorRaw?: unknown,
    @Query('page') pageRaw?: unknown,
    @Query('limit') limitRaw?: unknown,
  ) {
    // H2: this is one of two controllers binding named `@Query('x')`
    // params rather than a whole query object (cache.controller.ts's
    // `clear()` is the other), but Nest still reads each one straight off
    // `req.query[name]` underneath — a repeated `?entity=` key is just as
    // capable of arriving as an array here as it is anywhere else that
    // destructures the whole object.
    const entity = asString(entityRaw);
    const actor = asString(actorRaw);
    // H1: clamp the computed offset, not just the page number.
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(
      { page: pageRaw, limit: limitRaw },
      { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
    );

    const qb = this.auditRepo.createQueryBuilder('a').orderBy('a.createdAt', 'DESC');
    if (entity) qb.andWhere('a.entityType = :entity', { entity });
    if (actor) qb.andWhere('a.actorId = :actor', { actor });

    // 30-backend-finishing-prompt.md §2.5 (task 5): `beyondMaxOffset` still
    // means "never run the `OFFSET`-bearing query" (H1's whole point), but
    // it must not mean "report `total: 0`" — that told a caller the
    // (filtered) collection was empty when it might hold thousands of
    // rows, just not at this absurd a page number. `getCount()` alone is
    // cheap (no `LIMIT`/`OFFSET`, no row hydration) and carries the same
    // `entity`/`actor` filters as the real query would.
    if (beyondMaxOffset) {
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);

    // B3-2: was `{ rows, ... }` — the third pagination envelope shape in
    // the API (kernel used `pageSize`, public used `limit`). Standardised
    // on `{data, total, page, limit}` to match both.
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }
}
