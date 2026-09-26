import { SetMetadata } from '@nestjs/common';

export const PREVIEW_AWARE_KEY = 'cache:preview-aware';

/**
 * C24: marks a cached public route that can show an unpublished row to a
 * holder of a preview token (GET /admin/preview-token). Only on such a
 * route does `?preview=` change caching (see CacheInterceptor), and only
 * once the handler has actually verified the token (`req.previewVerified`).
 * Everywhere else `?preview=` is ignored and served from the cache like any
 * other request.
 */
export const PreviewAware = () => SetMetadata(PREVIEW_AWARE_KEY, true);
