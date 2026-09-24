import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { ProblemException } from '../../common/problem-details/problem.exception.js';
import { ErrorCode } from '../../common/problem-details/error-codes.js';
import type { RequestContext } from '../../common/request-context.js';
import type { UserRole } from '../../database/entities/user.entity.js';

/** `@Roles('admin')` — a route with no `@Roles()` metadata needs only a valid session. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestContext>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'Insufficient role');
    }
    return true;
  }
}
