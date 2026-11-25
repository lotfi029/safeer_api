import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permission.decorator.js';
import { can } from '../permissions.js';
import { ProblemException } from '../../common/problem-details/problem.exception.js';
import { ErrorCode } from '../../common/problem-details/error-codes.js';
import type { RequestContext } from '../../common/request-context.js';

/**
 * PERM-3 (replaces RolesGuard): a route with `@Permission(...)` needs every
 * key it names in the caller's role (`*` holds them all). A route with no
 * metadata needs only the valid session SessionGuard already checked.
 * `req.user.permissions` is loaded by SessionGuard on every request, so a
 * role edit applies on the user's next request.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestContext>();
    const held = req.user?.permissions;
    if (!held || !required.every((key) => can(held, key))) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'Insufficient permission');
    }
    return true;
  }
}
