import { SetMetadata } from '@nestjs/common';

export const CACHE_TAGS_KEY = 'cache:tags';

/**
 * Declares which cache tags a public GET route's response should be stored
 * under, e.g. `@CacheTags('home')`. A write to a collection purges its tag
 * (wired into the CRUD kernel, P8) and every cached response carrying that
 * tag is dropped on the next request.
 */
export const CacheTags = (...tags: string[]) => SetMetadata(CACHE_TAGS_KEY, tags);
