// C31: a purge that lands while a handler is reading must stop that
// (possibly stale) value from being cached.
import 'reflect-metadata';
import { CacheService } from '../../src/cache/cache.service';
import type { Env } from '../../src/config/env';

function service(): CacheService {
  return new CacheService({ CACHE_MAX_ENTRIES: 100, CACHE_TTL_SECONDS: 60 } as Env);
}

describe('CacheService tag versions (C31)', () => {
  it('stores when no purge happened since the snapshot', () => {
    const cache = service();
    const version = cache.versionOf(['news']);
    expect(cache.set('k', 1, ['news'], version)).toBe(true);
    expect(cache.get('k')).toBe(1);
  });

  it('skips the write when one of its tags was purged after the snapshot, even with nothing cached yet', () => {
    const cache = service();
    const version = cache.versionOf(['news', 'home']);
    cache.purgeTag('home');
    expect(cache.set('k', 'stale', ['news', 'home'], version)).toBe(false);
    expect(cache.get('k')).toBeUndefined();
  });

  it('a purge of an unrelated tag does not block the write', () => {
    const cache = service();
    const version = cache.versionOf(['news']);
    cache.purgeTag('pages');
    expect(cache.set('k', 1, ['news'], version)).toBe(true);
  });

  it('clear() invalidates every outstanding snapshot', () => {
    const cache = service();
    const version = cache.versionOf(['news']);
    cache.clear();
    expect(cache.set('k', 1, ['news'], version)).toBe(false);
  });

  it('applies to the memo store too', () => {
    const cache = service();
    const version = cache.versionOf(['posts']);
    cache.purgeTag('posts');
    expect(cache.setMemo('asset-public:1', true, ['posts'], version)).toBe(false);
    expect(cache.getMemo('asset-public:1')).toBeUndefined();
  });
});
