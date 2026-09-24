import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { ENV } from '../../config/env.tokens.js';
import type { Env } from '../../config/env.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { computeCsrfToken } from '../csrf.util.js';
import { ProblemException } from '../../common/problem-details/problem.exception.js';
import { ErrorCode } from '../../common/problem-details/error-codes.js';
import type { RequestContext } from '../../common/request-context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Second CSRF layer after SameSite=Strict (D-06). Runs after SessionGuard
 * (registration order in AppModule), so `req.sessionTokenHash` is already
 * set for any route that reaches here. Login, invite-accept, forgot and
 * reset are `@Public()` and skip this — there is no session yet to bind a
 * token to, and the "credential" a CSRF attacker would need to forge those
 * (a password, an emailed token) is not something a cookie carries anyway.
 *
 * I-8: every non-safe, session-authenticated write is covered, not just
 * `/admin/*` — `@Public()` and the `!sessionTokenHash` check below already
 * exempt what should be exempt (public writes like `/contact` never carry a
 * session token to bind a token to in the first place), so the extra
 * `isAdminRoute` condition this guard used to have was only ever narrowing
 * coverage, e.g. leaving `/auth/logout`, `/auth/password` and
 * `/auth/sessions` unchecked even though they're cookie-authenticated.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestContext>();
    if (SAFE_METHODS.has(req.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic || !req.sessionTokenHash) return true;

    const expected = computeCsrfToken(this.env.APP_ENCRYPTION_KEY, req.sessionTokenHash);
    const provided = req.headers['x-csrf-token'];

    if (typeof provided !== 'string' || !timingSafeCompare(expected, provided)) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'Missing or invalid CSRF token');
    }
    return true;
  }
}
