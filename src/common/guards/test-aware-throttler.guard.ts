import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ENV } from '../../config/env.tokens.js';
import type { Env } from '../../config/env.js';

/**
 * Phase 6 (safeer-backend-fix-prompt.md): the Jest suite (`test/`) drives a
 * real, running instance of this app over HTTP, and several routes it
 * exercises across many spec files share one hard-coded per-route
 * `@Throttle()` bucket each (`POST applications` 5/hour/IP, `POST
 * admin/auth/login` 5/60s/IP, `POST portal/auth/request-otp` 5/hour/IP, …) —
 * budgets `scripts/smoke.mjs` already spends most of in a single run.
 * Splitting the same coverage across `permissions.spec.ts`,
 * `apply-flow.spec.ts`, `documents.spec.ts`, `admin-review.spec.ts` and
 * `content.spec.ts` would blow every one of those buckets long before the
 * suite finishes.
 *
 * Delegates to a normally-DI-constructed `ThrottlerGuard` (registered as an
 * ordinary provider below, not `APP_GUARD` — see app.module.ts) rather than
 * subclassing it directly: `ThrottlerGuard`'s own constructor params carry
 * `@InjectThrottlerOptions()`/`@InjectThrottlerStorage()` decorators that a
 * subclass's own constructor wouldn't inherit.
 *
 * `NODE_ENV=test` is never a real deployment target (`config/env.ts`'s own
 * enum: `development | test | staging | production`) — it's already how
 * `test/global-setup.ts` boots the app under test, so this bypass can never
 * activate outside a test run. Every other environment gets the exact same
 * throttling behaviour as before.
 */
/** NODE_ENV=test only: a request carrying this header is throttled normally (see canActivate). */
export const ENFORCE_THROTTLE_HEADER = 'x-test-enforce-throttle';

@Injectable()
export class TestAwareThrottlerGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly throttlerGuard: ThrottlerGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> | boolean {
    if (this.env.NODE_ENV === 'test') {
      // A spec that asserts a route's own @Throttle opts back in per
      // request; only those requests are counted against the bucket.
      const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
      if (req.headers?.[ENFORCE_THROTTLE_HEADER] === '1') {
        return this.throttlerGuard.canActivate(context);
      }
      return true;
    }
    return this.throttlerGuard.canActivate(context);
  }
}
