import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Type } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CacheService } from '../../cache/cache.service.js';
import { declarePurger } from '../../cache/cache-tag-registry.js';
import { escapeLikeValue, readPageLimit, readString } from '../query/list-params.js';
import { ProblemException } from '../problem-details/problem.exception.js';
import { ErrorCode } from '../problem-details/error-codes.js';
import type { RequestContext } from '../request-context.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import type { UserRole } from '../../database/entities/user.entity.js';

/**
 * Deliberately `any`: zod's own `ZodType`/`ZodSchema` type defaults its
 * Output generic to `unknown`, which makes `createZodDto(schema)` — called
 * generically inside this factory against whatever schema each collection
 * passes in — resolve to a DTO class whose constructor "returns" `unknown`,
 * not an extendable type. Every real call site passes a concrete
 * `z.object({...}).strict()` value; only this factory's own internal
 * plumbing needs the parameter typed this loosely to make that generic
 * inference land on something `class X extends createZodDto(schema) {}` can
 * actually extend.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZodSchema = any;

// B3-2: was `pageSize` — every public list endpoint already uses
// `{data, total, page, limit}`; standardising the
// admin kernel onto the same shape now, before Session B (the admin
// dashboard) exists to generate against either one, is the version of this
// fix that breaks nothing.
export interface PagedResult<E> {
  data: E[];
  total: number;
  page: number;
  limit: number;
}

const RESERVED_QUERY_KEYS = new Set(['page', 'limit', 'q', 'published']);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * FR-F-03: any DTO field naming an image asset must point at one that
 * already has Arabic alt text. Case-insensitive on purpose: every
 * kernel-generated collection uses `xxxAssetId` (`coverAssetId`,
 * `imageAssetId`, ...), but `meeting_attachments`' bare `assetId` field is
 * the whole name with no prefix — `/AssetId$/` alone would silently miss it.
 */
const ASSET_ID_FIELD_RE = /AssetId$/i;

/** mysql2 error shape surfaced through TypeORM's QueryFailedError.driverError — same check as http-exception.filter.ts. */
function isRowReferencedError(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = (err as unknown as { driverError?: { code?: string; errno?: number } }).driverError;
  return driverError?.code === 'ER_ROW_IS_REFERENCED_2' || driverError?.errno === 1451;
}

/**
 * I-1: shared by every kernel-generated controller's `create`/`update`, and
 * by the two bespoke controllers that bypass the kernel entirely
 * (`site-settings` has no `*AssetId` field, so nothing to gate there;
 * `meeting-attachments` does and calls this directly). One raw query
 * against `media_assets` rather than a `MediaService` dependency — every
 * module using the kernel would otherwise need `MediaModule` imported just
 * for this check.
 */
export async function assertAltTextReady(dataSource: DataSource, dto: Record<string, unknown>): Promise<void> {
  const assetIds = Object.entries(dto)
    .filter(([key, value]) => ASSET_ID_FIELD_RE.test(key) && value != null)
    .map(([, value]) => String(value));
  if (assetIds.length === 0) return;

  const rows = await dataSource.query<{ id: string; kind: string; alt_ar: string | null }[]>(
    `SELECT id, kind, alt_ar FROM media_assets WHERE id IN (${assetIds.map(() => '?').join(',')})`,
    assetIds,
  );
  const blocked = rows.find((r) => r.kind === 'image' && !r.alt_ar);
  if (blocked) {
    throw new ProblemException(409, ErrorCode.ALT_TEXT_REQUIRED, 'This image needs Arabic alt text before it can be attached', {
      assetId: blocked.id,
    });
  }
}

const publishBodySchema = z.object({ isPublished: z.boolean().optional() }).strict();

/**
 * A subclass that overrides `update()` (posts/products' slug, library_items'
 * resolver, meetings' quorum check) can build its own `ReorderDto` with the
 * same validation, when the collection is sortable.
 *
 * C4: this DTO used to come with a trap — a subclass that overrode `update`
 * had to *also* redeclare `@Patch('reorder')` on a trivial pass-through
 * override, positioned before its own `update` override in the class body,
 * or `PATCH /reorder` would silently get swallowed by `PATCH /:id` (Nest's
 * `MetadataScanner` visits a subclass's own properties, in declaration
 * order, before walking up to the base class — so an unoverridden `reorder`
 * would register *after* an overridden `update`). A first attempt at fixing
 * this constrained `:id` to `:id(\d+)`, which is Express 4 syntax — this
 * project runs Express 5 / path-to-regexp 8, which removed custom parameter
 * regex outright, so that "fix" never let the app boot. The actual fix:
 * `reorder` is `POST`, everything id-addressed is `PATCH`/`DELETE` —
 * different HTTP methods never compete for the same route, under any
 * registration order, so no subclass has to do anything special at all.
 */
const reorderBodySchema = z.array(z.object({ id: z.string().min(1), sortOrder: z.number().int() })).min(1);

export interface CrudFactoryOptions<E extends { id: string }> {
  /** e.g. 'admin/stats' — the full route prefix, including the admin segment. */
  path: string;
  entity: Type<E>;
  createDto: AnyZodSchema;
  updateDto: AnyZodSchema;
  /** Adds `PATCH /:id/publish`. */
  publishable?: boolean;
  /** Adds `POST /reorder` (C4: a different HTTP method from `PATCH /:id`, never `PATCH /reorder` — see the comment above `reorderBodySchema`). */
  sortable?: boolean;
  /**
   * B0-4: roles allowed to `DELETE /:id`. Defaults to admin-only —
   * 11-architecture.md §3 puts "destructive endpoints" alongside users and
   * settings, and the association will have multiple editors. Pass
   * `['admin', 'editor']` for a collection where an editor genuinely owns
   * deletion.
   */
  deleteRoles?: UserRole[];
  /** Human label for the audit row. */
  label: (e: E) => string;
  /** Throws a PUBLISH_BLOCKED ProblemException when `e` isn't ready to publish. */
  publishRules?: (e: E) => void;
  /**
   * I-7: this entity's own public path (e.g. `/news/${e.slug}`), given
   * either its pre- or post-update state. When set, `update()` inserts a
   * redirect from the old path to the new one, in the same transaction as
   * the save, whenever a published row's `slug` actually changes.
   */
  redirectFrom?: (e: E) => string | null;
  searchable?: (keyof E & string)[];
  /**
   * Extra cache tags to purge on every write, beyond the collection's own
   * (P9): a collection that feeds `GET /home` or another composite read —
   * stats, about_items, partners, channels, languages, posts, products,
   * library_items, site_settings — passes `['home']` here so that composite
   * cache entry never serves stale data after an edit.
   */
  extraPurgeTags?: string[];
  /**
   * DB table name — used as the audit `entity_type` and the cache tag purged
   * after every write. Defaults to the entity's own table name via
   * TypeORM metadata when omitted.
   */
  entityType?: string;
}

/**
 * The CRUD kernel (13-backend-build-plan.md P8): one call gives a collection
 * `GET /` (paged, `?q=`, `?published=`, plus an automatic exact-match filter
 * for any other query key that names a real column — e.g. `?kind=`,
 * `?bodyId=`, `?categoryId=` — which is how `about_items`, `body_members`
 * and `documents` get their "filter by X" from the plan's table without any
 * extra code), `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, and,
 * conditionally, `PATCH /:id/publish` / `POST /reorder`.
 *
 * A collection that needs more (slug generation, a provider resolver, a
 * quorum check) subclasses the returned class and overrides just that
 * method — re-applying the matching `@Post()`/`@Patch(':id')` decorator on
 * the override, since method decorators attach to the specific function
 * object, not the property name, and are not inherited across an override.
 *
 * `@Get()/@Post()/@Patch(':id')/@Delete(':id')` are always applied; `publish`
 * and `reorder` are defined unconditionally too, but their route decorator
 * is only applied when `opts.publishable` / `opts.sortable` is set — calling
 * a Nest route decorator is a plain function call (target, key, descriptor)
 * => descriptor, so doing it imperatively after the class body is exactly as
 * safe as writing `@Patch(...)` inline. `reorder` is `POST`, not `PATCH` —
 * see the comment above the decorator applications, below, for why.
 */
export function CrudController<E extends { id: string }>(opts: CrudFactoryOptions<E>): Type<CrudControllerBase<E>> {
  // Every call defines classes literally named CreateDto/UpdateDto/etc — a
  // distinct class object each time (closed over this call's schema), but
  // Swagger's schema generator keys its component registry by class *name*,
  // not identity, so without renaming them it sees the same "CreateDto"
  // name reused with a different shape on every collection and warns (a
  // warning @nestjs/swagger says becomes a hard error in its next major
  // version).
  const namePrefix = (opts.entityType ?? opts.path).replace(/[^a-zA-Z0-9]/g, '_');
  class CreateDto extends createZodDto(opts.createDto) {}
  class UpdateDto extends createZodDto(opts.updateDto) {}
  class PublishDto extends createZodDto(publishBodySchema) {}
  class ReorderDto extends createZodDto(reorderBodySchema) {}
  for (const [cls, suffix] of [
    [CreateDto, 'CreateDto'],
    [UpdateDto, 'UpdateDto'],
    [PublishDto, 'PublishDto'],
    [ReorderDto, 'ReorderDto'],
  ] as const) {
    Object.defineProperty(cls, 'name', { value: `${namePrefix}${suffix}` });
  }

  // B3-1: every kernel-generated route requires a session (SessionGuard is
  // global, opt-in-to-@Public() rather than opt-in-to-auth), but nothing
  // told the OpenAPI document that — 0 of 150 operations carried a
  // `security` requirement despite addCookieAuth() being registered.
  // Class-level once here covers every route this factory generates.
  @Controller(opts.path)
  @ApiCookieAuth()
  class GeneratedCrudController extends CrudControllerBase<E> {
    constructor(
      @InjectRepository(opts.entity) repo: Repository<E>,
      cache: CacheService,
      @InjectDataSource() dataSource: DataSource,
    ) {
      super();
      this.repo = repo;
      this.cache = cache;
      this.dataSource = dataSource;
      this.entityType = opts.entityType ?? repo.metadata.tableName;
      // Tells CacheTagAssertion which tags this collection invalidates, so a
      // route served under a tag nobody purges refuses to boot. `entityType`
      // is included even though it is a table name that matches no public
      // tag for 13 of 14 collections — keeping the declaration honest about
      // what purge() actually calls is the point; the assertion only ever
      // fails in the other direction. See cache-tag-registry.ts.
      declarePurger(this.entityType, ...(opts.extraPurgeTags ?? []));
    }

    async list(@Query() query: Record<string, unknown>): Promise<PagedResult<E>> {
      // H1: clamp the computed offset, not just the page number — the
      // admin kernel is authenticated, but it is still one query away from
      // the same unbounded-OFFSET cost as the public routes.
      const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_PAGE_SIZE, maxLimit: MAX_PAGE_SIZE });

      const qb = this.repo.createQueryBuilder('e');

      // H2: readString guards every one of these — a repeated key
      // (`?q=a&q=b`, `?published=a&published=b`) used to reach
      // escapeLikeValue/mysql2 as a non-string value.
      const qParam = readString(query, 'q');
      if (qParam && opts.searchable?.length) {
        const escaped = escapeLikeValue(qParam);
        qb.andWhere(
          '(' + opts.searchable.map((field, i) => `e.${String(field)} LIKE :q${i} ESCAPE '\\\\'`).join(' OR ') + ')',
          Object.fromEntries(opts.searchable.map((_, i) => [`q${i}`, `%${escaped}%`])),
        );
      }

      const publishedParam = readString(query, 'published');
      if (opts.publishable && publishedParam !== undefined) {
        qb.andWhere('e.isPublished = :published', { published: publishedParam === 'true' });
      }

      for (const [key, value] of Object.entries(query)) {
        if (RESERVED_QUERY_KEYS.has(key)) continue;
        if (!this.repo.metadata.hasColumnWithPropertyPath(key)) continue;
        // H2: without this, `?slug[is_published]=1` (an object under the
        // 'simple' query parser — see list-params.ts's header comment for
        // which shapes actually reach here) silently became
        // `e.slug = `is_published` = '1'` once TypeORM/mysql2 finished
        // parameterising an object value — a filter bypass, not a crash.
        if (typeof value !== 'string') continue;
        qb.andWhere(`e.${key} = :${key}`, { [key]: value });
      }

      if (opts.sortable) {
        qb.orderBy('e.sortOrder', 'ASC').addOrderBy('e.id', 'ASC');
      } else {
        qb.orderBy('e.id', 'DESC');
      }

      // 30-backend-finishing-prompt.md §2.5 (task 5): `beyondMaxOffset`
      // still means "never run the `OFFSET`-bearing query" (H1's point),
      // but must not mean "report `total: 0`" — `getCount()` alone is
      // cheap and carries every filter built above, so this reports the
      // real (filtered) total instead of falsely claiming the collection
      // is empty.
      if (beyondMaxOffset) {
        const total = await qb.getCount();
        return { data: [], total, page, limit };
      }

      qb.skip(offset).take(limit);

      const [data, total] = await qb.getManyAndCount();
      return { data, total, page, limit };
    }

    async get(@Param('id') id: string): Promise<E> {
      return this.findOrNotFound(id);
    }

    async create(@Body() dto: CreateDto, @Req() req: RequestContext): Promise<E> {
      await assertAltTextReady(this.dataSource, dto as object as Record<string, unknown>);
      const entity = this.repo.create(dto as object as E);
      const saved = await this.repo.save(entity);
      this.purge();
      req.auditContext = {
        action: 'create',
        entityType: this.entityType,
        entityId: saved.id,
        entityLabel: opts.label(saved),
        after: saved,
      };
      return saved;
    }

    async reorder(@Body() dto: ReorderDto, @Req() req: RequestContext): Promise<{ reordered: number }> {
      await this.dataSource.transaction(async (manager) => {
        for (const item of dto) {
          await manager.update(opts.entity, { id: item.id } as object, { sortOrder: item.sortOrder } as object);
        }
      });
      this.purge();
      req.auditContext = {
        action: 'update',
        entityType: this.entityType,
        entityLabel: `reorder (${dto.length} items)`,
        after: dto,
      };
      return { reordered: dto.length };
    }

    async update(@Param('id') id: string, @Body() dto: UpdateDto, @Req() req: RequestContext): Promise<E> {
      await assertAltTextReady(this.dataSource, dto as object as Record<string, unknown>);
      const entity = await this.findOrNotFound(id);
      const before = { ...entity };
      Object.assign(entity, dto);
      // I-4: an edit must not leave a published row in a state that would have
      // failed its own publish check — mirrors the same guard in `publish()`.
      if ((entity as unknown as { isPublished?: boolean }).isPublished && opts.publishRules) {
        opts.publishRules(entity);
      }
      const saved = await this.saveWithRedirect(entity, before as E);
      this.purge();
      req.auditContext = {
        action: 'update',
        entityType: this.entityType,
        entityId: id,
        entityLabel: opts.label(saved),
        before,
        after: saved,
      };
      return saved;
    }

    async publish(@Param('id') id: string, @Body() dto: PublishDto, @Req() req: RequestContext): Promise<E> {
      const entity = await this.findOrNotFound(id);
      const nextState = dto.isPublished ?? true;
      if (nextState && opts.publishRules) {
        opts.publishRules(entity);
      }
      (entity as unknown as { isPublished: boolean }).isPublished = nextState;
      const saved = await this.repo.save(entity);
      this.purge();
      req.auditContext = {
        action: nextState ? 'publish' : 'unpublish',
        entityType: this.entityType,
        entityId: id,
        entityLabel: opts.label(saved),
      };
      return saved;
    }

    async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
      const entity = await this.findOrNotFound(id);
      const snapshot = { ...entity };
      const label = opts.label(entity);
      try {
        await this.repo.remove(entity);
      } catch (err) {
        // I-9: the global filter already maps this to a generic 409 CONFLICT
        // as a backstop (http-exception.filter.ts) — this gives the editor
        // something actionable instead, the way media.service.ts does for
        // the same error class on media_assets specifically.
        if (isRowReferencedError(err)) {
          throw new ProblemException(409, ErrorCode.RESOURCE_IN_USE, `"${label}" is referenced by other records and cannot be deleted`);
        }
        throw err;
      }
      this.purge();
      req.auditContext = {
        action: 'delete',
        entityType: this.entityType,
        entityId: id,
        entityLabel: label,
        before: snapshot,
      };
      return { deleted: true };
    }

    protected async findOrNotFound(id: string): Promise<E> {
      const entity = await this.repo.findOne({ where: { id } as object });
      if (!entity) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
      return entity;
    }

    protected purge(): void {
      this.cache.purgeTag(this.entityType);
      for (const tag of opts.extraPurgeTags ?? []) {
        this.cache.purgeTag(tag);
      }
    }

    /**
     * I-7: `posts`, `products` and `library_items` have no dedicated service
     * file — this kernel generates their entire `update()` — so the
     * redirect-on-slug-change logic has to live here rather than in a
     * per-module service that doesn't exist. Only fires for a row that was
     * already published (an unpublished row's URL was never live) whose
     * slug is actually changing; the insert and the save happen in one
     * transaction, and `ON DUPLICATE KEY UPDATE` handles a `from_path` that
     * collides with an existing redirect (e.g. the slug flip-flopping).
     */
    protected async saveWithRedirect(entity: E, before: E): Promise<E> {
      if (!opts.redirectFrom) return this.repo.save(entity);

      const wasPublished = (before as unknown as { isPublished?: boolean }).isPublished;
      const beforeSlug = (before as unknown as { slug?: string }).slug;
      const afterSlug = (entity as unknown as { slug?: string }).slug;
      if (!wasPublished || !beforeSlug || !afterSlug || beforeSlug === afterSlug) {
        return this.repo.save(entity);
      }

      const fromPath = opts.redirectFrom(before);
      const toPath = opts.redirectFrom(entity);
      if (!fromPath || !toPath || fromPath === toPath) {
        return this.repo.save(entity);
      }

      return this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(opts.entity, entity as object as E);
        // Collapse redirect chains: a row renamed A→B earlier, then B→C now,
        // would otherwise leave both `A→B` and `B→C` — a visitor to A takes
        // two hops, the first of which lands on a path that's itself moved.
        // Repointing any existing row whose to_path was the old path makes
        // A→C direct the moment B→C is created.
        await manager.query('UPDATE redirects SET to_path = ? WHERE to_path = ?', [toPath, fromPath]);
        // `VALUES()` in ON DUPLICATE KEY UPDATE is deprecated as of MySQL
        // 8.0.20; this is the row-alias form it was replaced with.
        await manager.query(
          'INSERT INTO redirects (from_path, to_path) VALUES (?, ?) AS new ON DUPLICATE KEY UPDATE to_path = new.to_path',
          [fromPath, toPath],
        );
        return saved;
      });
    }
  }

  // C4: `reorder` is registered as POST, not PATCH — a different HTTP method
  // from `update`'s `PATCH /:id`, so the two can never compete for the same
  // route under any registration order. (An earlier version of this fix
  // instead constrained `:id` to `:id(\d+)`, betting that 'reorder' could
  // never match a numeric-only param — Express 4 syntax that Express 5 /
  // path-to-regexp 8 rejects outright, so that version never let the app
  // boot at all.) This is why no subclass extending this kernel needs any
  // discipline around declaration order or route patterns, structurally,
  // not by convention.
  // B3-1: `list()`'s query params were entirely undocumented (a whole-object
  // `@Query() query: Record<string, string>` gives @nestjs/swagger no
  // individual param names to infer, unlike a bare `@Query('name')`).
  // Every kernel collection accepts page/limit; `q` and `published` only
  // apply when the collection is `searchable`/`publishable`, but declaring
  // them as optional on every collection is harmless — a caller that
  // doesn't send them sees no difference.
  const listDescriptor = Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'list')!;
  ApiQuery({ name: 'page', required: false, type: String })(GeneratedCrudController.prototype, 'list', listDescriptor);
  ApiQuery({ name: 'limit', required: false, type: String })(GeneratedCrudController.prototype, 'list', listDescriptor);
  ApiQuery({ name: 'q', required: false, type: String })(GeneratedCrudController.prototype, 'list', listDescriptor);
  ApiQuery({ name: 'published', required: false, type: String })(GeneratedCrudController.prototype, 'list', listDescriptor);
  Get()(GeneratedCrudController.prototype, 'list', listDescriptor);
  Get(':id')(GeneratedCrudController.prototype, 'get', Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'get')!);
  Post()(GeneratedCrudController.prototype, 'create', Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'create')!);
  Patch(':id')(GeneratedCrudController.prototype, 'update', Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'update')!);

  // B0-4: RolesGuard is opt-in (no @Roles metadata means any valid session
  // passes), so `remove` needs it applied explicitly — without this, any
  // editor could delete any row in every collection built on this kernel.
  // Same trap as C4: a subclass that ever overrides `remove` gets a *new*
  // function object with no metadata on it and must re-apply `@Roles(...)`
  // itself. No subclass does today.
  const removeDescriptor = Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'remove')!;
  Roles(...(opts.deleteRoles ?? ['admin']))(GeneratedCrudController.prototype, 'remove', removeDescriptor);
  Delete(':id')(GeneratedCrudController.prototype, 'remove', removeDescriptor);

  if (opts.publishable) {
    Patch(':id/publish')(GeneratedCrudController.prototype, 'publish', Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'publish')!);
  }
  if (opts.sortable) {
    Post('reorder')(GeneratedCrudController.prototype, 'reorder', Object.getOwnPropertyDescriptor(GeneratedCrudController.prototype, 'reorder')!);
  }

  return GeneratedCrudController;
}

/**
 * The shape every generated controller (and its subclasses) exposes.
 * Deliberately *not* an `abstract class`: a subclass that overrides
 * `create`/`update`/`publish` to add its own logic (posts/products' slug,
 * library_items' provider resolution, meetings' quorum check) calls
 * `super.create(...)` etc, and TypeScript refuses to call an abstract member
 * through `super` even when the runtime value behind it is a concrete
 * implementation (`GeneratedCrudController`, below). The bodies here never
 * actually run — `GeneratedCrudController` overrides every one of them — so
 * they just throw if that ever stops being true.
 */
export class CrudControllerBase<E extends { id: string }> {
  protected repo!: Repository<E>;
  protected cache!: CacheService;
  protected dataSource!: DataSource;
  protected entityType!: string;

  protected async findOrNotFound(_id: string): Promise<E> {
    throw new Error('CrudControllerBase.findOrNotFound was not overridden');
  }

  protected purge(): void {
    throw new Error('CrudControllerBase.purge was not overridden');
  }

  // B10 (safeer-backend-fr-review.md): was `Record<string, string>`, which
  // didn't match `GeneratedCrudController.list()`'s own real parameter type
  // below — harmless as long as nothing called `super.list()`, but
  // `AdminPagesController` now does (admin-pages.controller.ts).
  async list(_query: Record<string, unknown>): Promise<PagedResult<E>> {
    throw new Error('CrudControllerBase.list was not overridden');
  }

  async get(_id: string): Promise<E> {
    throw new Error('CrudControllerBase.get was not overridden');
  }

  async create(_dto: unknown, _req: RequestContext): Promise<E> {
    throw new Error('CrudControllerBase.create was not overridden');
  }

  async update(_id: string, _dto: unknown, _req: RequestContext): Promise<E> {
    throw new Error('CrudControllerBase.update was not overridden');
  }

  async remove(_id: string, _req: RequestContext): Promise<{ deleted: true }> {
    throw new Error('CrudControllerBase.remove was not overridden');
  }

  async publish(_id: string, _dto: unknown, _req: RequestContext): Promise<E> {
    throw new Error('CrudControllerBase.publish was not overridden');
  }

  async reorder(_dto: { id: string; sortOrder: number }[], _req: RequestContext): Promise<{ reordered: number }> {
    throw new Error('CrudControllerBase.reorder was not overridden');
  }
}
