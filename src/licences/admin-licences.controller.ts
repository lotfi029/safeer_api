import { Body, Controller, Delete, Param, Patch, Post, Req } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CrudController, assertAltTextReady } from '../common/crud/crud.factory.js';
import { CacheService } from '../cache/cache.service.js';
import { Area } from '../auth/role-matrix.js';
import { Licence } from '../database/entities/licence.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { CreateLicenceDto, PublishLicenceDto, UpdateLicenceDto, createLicenceSchema, updateLicenceSchema } from './dto/licence.dto.js';

const BaseLicencesController = CrudController<Licence>({
  path: 'admin/licences',
  deleteArea: 'content',
  entity: Licence,
  createDto: createLicenceSchema,
  updateDto: updateLicenceSchema,
  publishable: true,
  sortable: true,
  searchable: ['titleAr', 'titleEn', 'number'],
  // `licences`: the public list (the kernel purges the table name itself).
  // `site_settings` and `home`: the primary licence is written through to
  // site_settings, which GET /site and GET /home serve.
  extraPurgeTags: ['site_settings', 'home'],
  label: (l) => l.titleAr,
});

/**
 * Admin CRUD for the association's licences (022), ported from
 * african_api's licences-admin.controller.ts and adapted:
 *
 * 1. at most one primary: becoming primary (on create, update or
 *    `PATCH :id/primary`) clears every other row's flag;
 * 2. the primary *published* licence's number and issuer are written
 *    through to site_settings after every write (create, update, publish,
 *    primary, delete) — or cleared when there is no such licence — so the
 *    footer and contact page read one place (GET /site);
 * 3. an attached asset must exist (400 naming `assetId`, not a foreign-key
 *    500) and, if it is an image, have Arabic alt text (the kernel's rule).
 *
 * Every write runs in one transaction that first locks the site_settings
 * row: it always exists and the write-through changes it anyway, so two
 * concurrent "make primary" requests are serialised even when the licences
 * table is empty.
 */
@Controller('admin/licences')
@Area('content')
export class AdminLicencesController extends BaseLicencesController {
  constructor(
    @InjectRepository(Licence) repo: Repository<Licence>,
    cache: CacheService,
    @InjectDataSource() dataSource: DataSource,
  ) {
    super(repo, cache, dataSource);
  }

  @Post()
  override async create(@Body() dto: CreateLicenceDto, @Req() req: RequestContext): Promise<Licence> {
    await this.validateAsset(dto.assetId);
    await assertAltTextReady(this.dataSource, dto as unknown as Record<string, unknown>);
    const draft = this.repo.create(dto as Partial<Licence>);
    assertDates(draft);

    const saved = await this.dataSource.transaction(async (manager) => {
      await lockSettings(manager);
      if (draft.isPrimary) await clearPrimary(manager);
      const saved = await manager.save(Licence, draft);
      await syncSiteSettings(manager);
      return saved;
    });

    this.purge();
    req.auditContext = { action: 'create', entityType: this.entityType, entityId: saved.id, entityLabel: saved.titleAr, after: saved };
    return saved;
  }

  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdateLicenceDto, @Req() req: RequestContext): Promise<Licence> {
    await this.validateAsset(dto.assetId);
    await assertAltTextReady(this.dataSource, dto as unknown as Record<string, unknown>);

    const { saved, before } = await this.dataSource.transaction(async (manager) => {
      await lockSettings(manager);
      const current = await findLocked(manager, id);
      const before = { ...current };
      Object.assign(current, dto);
      assertDates(current);
      if (current.isPrimary && !before.isPrimary) await clearPrimary(manager);
      const saved = await manager.save(Licence, current);
      await syncSiteSettings(manager);
      return { saved, before };
    });

    this.purge();
    req.auditContext = {
      action: before.isPublished === saved.isPublished ? 'update' : saved.isPublished ? 'publish' : 'unpublish',
      entityType: this.entityType,
      entityId: id,
      entityLabel: saved.titleAr,
      before,
      after: saved,
    };
    return saved;
  }

  @Patch(':id/publish')
  override async publish(@Param('id') id: string, @Body() dto: PublishLicenceDto, @Req() req: RequestContext): Promise<Licence> {
    const isPublished = dto.isPublished ?? true;
    const saved = await this.dataSource.transaction(async (manager) => {
      await lockSettings(manager);
      const current = await findLocked(manager, id);
      current.isPublished = isPublished;
      const saved = await manager.save(Licence, current);
      await syncSiteSettings(manager);
      return saved;
    });

    this.purge();
    req.auditContext = { action: isPublished ? 'publish' : 'unpublish', entityType: this.entityType, entityId: id, entityLabel: saved.titleAr };
    return saved;
  }

  /** Makes this licence the primary one; site_settings follows once it is published. */
  @Patch(':id/primary')
  async makePrimary(@Param('id') id: string, @Req() req: RequestContext): Promise<Licence> {
    const saved = await this.dataSource.transaction(async (manager) => {
      await lockSettings(manager);
      const current = await findLocked(manager, id);
      await clearPrimary(manager);
      current.isPrimary = true;
      const saved = await manager.save(Licence, current);
      await syncSiteSettings(manager);
      return saved;
    });

    this.purge();
    req.auditContext = {
      action: 'update',
      entityType: this.entityType,
      entityId: id,
      entityLabel: saved.titleAr,
      after: { isPrimary: true, number: saved.number },
    };
    return saved;
  }

  // Overriding `remove` drops the kernel's decorators — both re-applied here
  // (crud.factory.ts, B0-4).
  @Area('content')
  @Delete(':id')
  override async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const snapshot = await this.dataSource.transaction(async (manager) => {
      await lockSettings(manager);
      const current = await findLocked(manager, id);
      const snapshot = { ...current };
      await manager.remove(Licence, current);
      await syncSiteSettings(manager);
      return snapshot;
    });

    this.purge();
    req.auditContext = { action: 'delete', entityType: this.entityType, entityId: id, entityLabel: snapshot.titleAr, before: snapshot };
    return { deleted: true };
  }

  /** A bad document reference is a 400 naming the field, not a foreign-key 500. */
  private async validateAsset(assetId: string | null | undefined): Promise<void> {
    if (!assetId) return;
    const rows: unknown[] = await this.dataSource.query('SELECT 1 FROM media_assets WHERE id = ? LIMIT 1', [assetId]);
    if (rows.length === 0) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'The licence document does not exist', { field: 'assetId' });
    }
  }
}

function assertDates(licence: Pick<Licence, 'issuedOn' | 'expiresOn'>): void {
  if (licence.issuedOn && licence.expiresOn && licence.expiresOn < licence.issuedOn) {
    throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'expiresOn must not be before issuedOn', { field: 'expiresOn' });
  }
}

async function findLocked(manager: EntityManager, id: string): Promise<Licence> {
  const licence = await manager.findOne(Licence, { where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!licence) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
  return licence;
}

async function lockSettings(manager: EntityManager): Promise<void> {
  await manager.query('SELECT id FROM site_settings WHERE id = 1 FOR UPDATE');
}

async function clearPrimary(manager: EntityManager): Promise<void> {
  await manager.query('UPDATE licences SET is_primary = 0 WHERE is_primary = 1');
}

/**
 * site_settings.licence_no / licence_issuer_ar / licence_issuer_en follow
 * the primary published licence — or go back to null when there is none,
 * rather than leaving a stale number next to the footer.
 */
async function syncSiteSettings(manager: EntityManager): Promise<void> {
  const [primary] = await manager.query<{ number: string | null; issuer_ar: string | null; issuer_en: string | null }[]>(
    'SELECT number, issuer_ar, issuer_en FROM licences WHERE is_primary = 1 AND is_published = 1 ORDER BY id LIMIT 1',
  );
  await manager.query('UPDATE site_settings SET licence_no = ?, licence_issuer_ar = ?, licence_issuer_en = ? WHERE id = 1', [
    primary?.number || null,
    primary?.issuer_ar || null,
    primary?.issuer_en || null,
  ]);
}
