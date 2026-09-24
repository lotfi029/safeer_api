/**
 * The purger half of the tag contract. `@CacheTags(...)` declares which tags a
 * public GET route's response is *stored* under; this declares which tags some
 * write path actually *purges*. `CacheTagAssertion` compares the two at boot.
 *
 * Why this exists: the CRUD kernel's primary purge is
 * `purgeTag(this.entityType)`, and `entityType` defaults to the entity's DB
 * table name (crud.factory.ts:223). No public route anywhere is tagged with a
 * table name — the served tags are `home`, `news`, `governance`, `library`,
 * `languages`, `redirects` — so that call is a silent no-op for 13 of the 14
 * kernel collections, and `languages` only matches because its table name
 * happens to equal its public tag. Every collection therefore invalidates
 * purely through `extraPurgeTags`, and `library_items` shipped with
 * `extraPurgeTags: ['home']` and no `'library'`: publishing, reordering or
 * unpublishing a library item changed nothing on the public site for a full
 * TTL, and up to 10x that behind a CDN's stale-while-revalidate.
 *
 * `entityType` is not just a cache tag — it is also the `audit_log.entity_type`
 * value written by the same kernel — so it can't simply be renamed. A boot-time
 * assertion is the cheap way to make the same mistake unshippable instead.
 */
const purgers = new Set<string>();

/**
 * Called from the constructor of anything that purges — the generated CRUD
 * controller, and each hand-written write path that calls `purgeTag` itself.
 * Constructors run during module init, which is before
 * `onApplicationBootstrap`, so the set is complete by the time the assertion
 * reads it.
 */
export function declarePurger(...tags: (string | undefined | null)[]): void {
  for (const tag of tags) {
    if (tag) purgers.add(tag);
  }
}

export function declaredPurgers(): ReadonlySet<string> {
  return purgers;
}
