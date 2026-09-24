import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { readString } from '../common/query/list-params.js';
import { issuePreviewToken, PREVIEW_TOKEN_TTL_SECONDS, type PreviewCollection } from '../auth/preview-token.util.js';

/**
 * TODO(phase 4+): repository injections for each previewable collection
 * land here as their entities do (see preview-token.util.ts's
 * PreviewCollection). african_api's equivalent injects Post, LibraryItem
 * and Meeting repositories and checks `rowExists` against each — do the
 * same for Safeer's content modules (news, etc.) once they exist.
 */
const PREVIEW_COLLECTIONS: readonly PreviewCollection[] = [];

function isPreviewCollection(value: string): value is PreviewCollection {
  return (PREVIEW_COLLECTIONS as readonly string[]).includes(value);
}

/**
 * FR-G-05 equivalent: mints the token a public detail route accepts as
 * `?preview=` to show an unpublished row. No `@Roles()` — any authenticated
 * session can preview, same as the CRUD kernel's own create/update, and the
 * row lookup below already confines a token to something that exists.
 *
 * Currently issues no tokens at all (PREVIEW_COLLECTIONS is empty — no
 * content module has landed yet in this phase), always answering 400. This
 * keeps the route, its auth, and its shape in place for later phases to
 * extend without re-plumbing the controller.
 */
@Controller('admin/preview-token')
@ApiCookieAuth()
export class PreviewController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @ApiQuery({ name: 'collection', required: true, type: String, enum: PREVIEW_COLLECTIONS as unknown as string[] })
  @ApiQuery({ name: 'id', required: true, type: String })
  @Get()
  async issue(@Query() query: Record<string, unknown>): Promise<{ token: string; expiresInSeconds: number }> {
    const collection = readString(query, 'collection');
    const id = readString(query, 'id');
    if (!collection || !id || !isPreviewCollection(collection)) {
      throw new ProblemException(
        400,
        ErrorCode.VALIDATION_FAILED,
        PREVIEW_COLLECTIONS.length > 0
          ? `collection must be one of ${PREVIEW_COLLECTIONS.join(', ')}, and id is required`
          : 'No collection currently supports preview',
      );
    }
    if (!(await this.rowExists(collection, id))) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }

    const token = issuePreviewToken(this.env.APP_ENCRYPTION_KEY, collection, id);
    return { token, expiresInSeconds: PREVIEW_TOKEN_TTL_SECONDS };
  }

  /**
   * Existence-checked against the row's own table rather than just trusting
   * the whitelisted name — a token minted for a row that doesn't exist is a
   * token for nothing, but there is no reason to hand one out rather than a
   * 404.
   */
  private async rowExists(collection: PreviewCollection, _id: string): Promise<boolean> {
    // Exhaustive switch over PreviewCollection — currently `never`, so this
    // never actually runs; later phases add a `case` per collection here.
    switch (collection) {
      default:
        return false;
    }
  }
}
