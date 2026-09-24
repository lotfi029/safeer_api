import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestWithId extends Request {
  id: string;
}

/** Assigns a request id used to correlate logs with the problem+json body returned on error. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  (req as RequestWithId).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
