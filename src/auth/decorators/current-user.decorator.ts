import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestContext } from '../../common/request-context.js';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
  const req = ctx.switchToHttp().getRequest<RequestContext>();
  return req.user;
});
