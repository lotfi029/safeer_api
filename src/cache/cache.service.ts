import { Inject, Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

interface CacheEntry {
  value: unknown;
  tags: string[];
}

// B1-7: `max` alone bounds *entry count*, not memory — a single /home
// payload or a library page with joined assets can run hundreds of KB, so
// CACHE_MAX_ENTRIES (default 500) of those is an unbounded-memory footgun.
// No env var for this yet (nothing has needed to tune it); a conservative
// fixed ceiling, well under what a single PM2 `instances: 1` process (D-10)
// should ever need to dedicate to a response cache.
//
// 28-caching-review.md §4.4: this is a *character* ceiling, not a byte one,
// despite the name — sizeCalculation below counts `.length` on a
// JSON-stringified value, which is UTF-16 code units. V8 stores any
// non-Latin-1 string (all of this app's Arabic content) at 2 bytes per code
// unit, so the real resident footprint of this "25 MB" number is closer to
// 50 MB on this Arabic-heavy payload. Not dangerous at this scale, but the
// number should be read as what it measures, not what it's named.
const CACHE_MAX_BYTES = 25 * 1024 * 1024;

// 28-caching-review.md §4.4: `JSON.stringify` throws on a circular
// structure, and sizeCalculation runs inside the `set()` call that
// CacheInterceptor makes from within `tap()` on the response path — an
// uncaught throw there turns a successful request into a 500. Nothing in
// this codebase triggers it today (no cached route returns an entity graph
// with a loaded inverse relation), but one eager `@OneToMany` added later
// would be enough, and the failure mode (silently breaking every request to
// that route) is worse than the conservative fallback below.
const SIZE_CALCULATION_FALLBACK_BYTES = 64 * 1024;

/**
 * 30-backend-finishing-prompt.md §2.2: a boolean-valued memo store,
 * deliberately separate from the response cache above rather than sharing
 * its budget. media.service.ts's `isPubliclyReadable()` runs a ten-branch
 * UNION on every `/files` request — memoising the result is the fix, but
 * memoising it *into the response LRU* would just relocate the residency
 * problem 26-backend-code-review.md's B1-7 (and this pass's task 3) exist
 * to close: a governance members page with two hundred photos would evict
 * two hundred real page responses to hold two hundred booleans. No
 * `maxSize`/`sizeCalculation` here — every value is a plain boolean, so the
 * byte accounting the response cache needs for Arabic JSON payloads (see
 * CACHE_MAX_BYTES's comment) is pure overhead for this store. 5,000 is
 * comfortably above this repo's dev `media_assets` count today with room to
 * grow, while still bounding memory for a media library that grows without
 * limit.
 */
const MEMO_MAX_ENTRIES = 5_000;

export interface CacheStats {
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  uptimeSeconds: number;
}

/**
 * In-process LRU with tag purge (D-10, trap 9) — get/set/purgeTag plus
 * stats/clear for the admin screen (P11) is the whole interface for the
 * response cache. Keeping it this small is what lets Redis drop in later
 * without touching a caller, if the API ever needs more than one process.
 *
 * `getMemo`/`setMemo` below are a second, independent store behind the same
 * tag-purge mechanism (`tagIndex` is shared, so one `purgeTag()` call
 * invalidates matching keys in both) — see MEMO_MAX_ENTRIES above for why it
 * isn't just a second call into `set()`. Deliberately excluded from
 * `hits`/`misses`/`stats().entries`: FR-G-12's cache-admin screen should
 * keep measuring the response cache specifically, not a mix of page
 * responses and unrelated boolean memos.
 */
@Injectable()
export class CacheService {
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly memoCache: LRUCache<string, CacheEntry>;
  private readonly tagIndex = new Map<string, Set<string>>();
  /**
   * C31: bumped by every purgeTag() (and, for all tags at once, clear()).
   * A caller snapshots the versions of the tags it will store under
   * *before* reading the data (`versionOf()`), and passes that snapshot to
   * set()/setMemo(): if a write purged one of those tags while the handler
   * was reading, the value may predate the write, so it isn't stored.
   * Without this, a miss → read → (purge) → set sequence re-cached stale
   * data for a full TTL after the edit.
   */
  private readonly tagVersions = new Map<string, number>();
  private epoch = 0;
  private hits = 0;
  private misses = 0;
  private readonly startedAt = Date.now();

  constructor(@Inject(ENV) env: Env) {
    this.cache = new LRUCache<string, CacheEntry>({
      max: env.CACHE_MAX_ENTRIES,
      maxSize: CACHE_MAX_BYTES,
      sizeCalculation: (entry) => {
        try {
          return Math.max(1, JSON.stringify(entry.value).length);
        } catch {
          return SIZE_CALCULATION_FALLBACK_BYTES;
        }
      },
      ttl: env.CACHE_TTL_SECONDS * 1000,
      dispose: (entry, key) => this.untagKey(key, entry.tags),
    });

    this.memoCache = new LRUCache<string, CacheEntry>({
      max: MEMO_MAX_ENTRIES,
      ttl: env.CACHE_TTL_SECONDS * 1000,
      dispose: (entry, key) => this.untagKey(key, entry.tags),
    });
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value as T;
  }

  /** C31: an opaque snapshot of `tags`' purge versions, for set()/setMemo()'s `ifVersion`. */
  versionOf(tags: string[]): string {
    return `${this.epoch}:${tags.map((t) => this.tagVersions.get(t) ?? 0).join(',')}`;
  }

  /** Returns false (and stores nothing) when `ifVersion` is given and one of `tags` was purged since that snapshot. */
  set<T>(key: string, value: T, tags: string[] = [], ifVersion?: string): boolean {
    if (ifVersion !== undefined && ifVersion !== this.versionOf(tags)) return false;
    // Replacing an existing entry: drop its old tag associations first so a
    // key never lingers in a tag's index under a tag it no longer carries.
    const existing = this.cache.peek(key);
    if (existing) this.untagKey(key, existing.tags);

    this.cache.set(key, { value, tags });
    this.tagKey(key, tags);
    return true;
  }

  /** Same read contract as `get()`, against the boolean memo store instead of the response cache — see the class comment. */
  getMemo(key: string): boolean | undefined {
    const entry = this.memoCache.get(key);
    return entry === undefined ? undefined : (entry.value as boolean);
  }

  /** Same write contract as `set()`, against the boolean memo store instead of the response cache — see the class comment. */
  setMemo(key: string, value: boolean, tags: string[] = [], ifVersion?: string): boolean {
    if (ifVersion !== undefined && ifVersion !== this.versionOf(tags)) return false;
    const existing = this.memoCache.peek(key);
    if (existing) this.untagKey(key, existing.tags);

    this.memoCache.set(key, { value, tags });
    this.tagKey(key, tags);
    return true;
  }

  /**
   * Purges every entry carrying `tag`, in either store — a write to a
   * collection that owns cached pages *and* media-asset memos (e.g.
   * publishing a library item) must invalidate both with one call. The
   * returned count is response-cache entries only, matching what
   * cache.controller.ts's audit label has always meant by "purged"; the
   * memo store is an internal implementation detail of `/files`, not
   * something FR-G-12's admin screen reports on.
   */
  purgeTag(tag: string): number {
    this.tagVersions.set(tag, (this.tagVersions.get(tag) ?? 0) + 1);
    const keys = this.tagIndex.get(tag);
    if (!keys) return 0;
    let purged = 0;
    for (const key of keys) {
      if (this.cache.delete(key)) purged++;
      else this.memoCache.delete(key);
    }
    this.tagIndex.delete(tag);
    return purged;
  }

  clear(): void {
    this.epoch++;
    this.cache.clear();
    this.memoCache.clear();
    this.tagIndex.clear();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      maxEntries: this.cache.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private tagKey(key: string, tags: string[]): void {
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  private untagKey(key: string, tags: string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.tagIndex.delete(tag);
    }
  }
}
