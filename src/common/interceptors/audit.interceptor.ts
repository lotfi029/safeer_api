import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Repository } from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity.js';
import { isAdminRoute, type RequestContext } from '../request-context.js';

/**
 * After any successful request under /admin, writes an audit_log row from
 * `req.auditContext` — set by the service/controller that handled the
 * write, since only it knows what actually changed
 * (13-backend-build-plan.md P5, P8). A route that performs no domain write
 * (e.g. a pure lookup) simply leaves `auditContext` unset and nothing is
 * recorded. Append-only: this interceptor only ever inserts.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(@InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestContext>();
    // C36: a read is audited only when its handler asks to be (the
    // applications CSV export sets `auditContext`); every other GET leaves
    // it unset and records nothing, same as before.
    if (!isAdminRoute(req.path) || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const audit = req.auditContext;
        if (!audit) return;

        const hasDiff = audit.before !== undefined || audit.after !== undefined;
        this.auditRepo
          .insert({
            actorId: req.user?.id ?? null,
            action: audit.action,
            entityType: audit.entityType,
            entityId: audit.entityId ?? null,
            entityLabel: audit.entityLabel ?? null,
            // TypeORM's insert() typing for a JSON column wants a deep-partial
            // of its declared shape rather than an arbitrary object; the
            // column is genuinely a free-form {before, after} snapshot.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            diff: (hasDiff ? { before: audit.before ?? null, after: audit.after ?? null } : null) as any,
            ipHash: req.ipHash ?? null,
          })
          .catch((err: unknown) => {
            // An audit-log failure must never surface as the write's own
            // failure — the write already succeeded and its response is
            // already committed to being sent.
            this.logger.error('Failed to write audit log row', err instanceof Error ? err.stack : String(err));
          });
      }),
    );
  }
}
