import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { readString } from '../common/query/list-params.js';
import { issuePreviewToken, PREVIEW_TOKEN_TTL_SECONDS, type PreviewCollection } from '../auth/preview-token.util.js';
import { Post } from '../database/entities/post.entity.js';

const PREVIEW_COLLECTIONS: readonly PreviewCollection[] = ['posts'];

function isPreviewCollection(value: string): value is PreviewCollection {
  return (PREVIEW_COLLECTIONS as readonly string[]).includes(value);
}

/**
 * FR-G-05 equivalent: mints the token `news.controller.ts`'s public
 * `GET news/:slug` accepts as `?preview=` to show an unpublished row. No
 * `@Roles()` — any authenticated session can preview, same as the CRUD
 * kernel's own create/update, and the row lookup below already confines a
 * token to something that exists.
 */
@Controller('admin/preview-token')
@ApiCookieAuth()
export class PreviewController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
  ) {}

  @ApiQuery({ name: 'collection', required: true, type: String, enum: PREVIEW_COLLECTIONS as unknown as string[] })
  @ApiQuery({ name: 'id', required: true, type: String })
  @Get()
  async issue(@Query() query: Record<string, unknown>): Promise<{ token: string; expiresInSeconds: number }> {
    const collection = readString(query, 'collection');
    const id = readString(query, 'id');
    if (!collection || !id || !isPreviewCollection(collection)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `collection must be one of ${PREVIEW_COLLECTIONS.join(', ')}, and id is required`);
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
  private async rowExists(collection: PreviewCollection, id: string): Promise<boolean> {
    switch (collection) {
      case 'posts':
        return this.postRepo.exists({ where: { id } });
    }
  }
}
