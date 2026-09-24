import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RequestContext } from './request-context.js';

/**
 * IP addresses are hashed, never stored raw (NFR-11; sessions.ip_hash,
 * audit_log.ip_hash, contact_messages.ip_hash). The salt makes the hash
 * infeasible to reverse by dictionary/rainbow-table even though IPv4 space
 * is small.
 */
export function ipHashMiddleware(salt: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    (req as RequestContext).ipHash = ip
      ? createHash('sha256').update(ip + salt).digest('hex')
      : null;
    next();
  };
}
