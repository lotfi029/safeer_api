import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { ZodValidationException } from 'nestjs-zod';
import { ErrorCode } from '../problem-details/error-codes.js';
import { ProblemException } from '../problem-details/problem.exception.js';
import type { RequestWithId } from '../request-id.middleware.js';

/**
 * A code outside the specified 13 (13-backend-build-plan.md P5), used only as
 * a safety net so this global filter can never leak a raw framework error or
 * an unmapped database driver error to the client. Any code path that has a
 * proper spec code (ASSET_IN_USE, SLUG_TAKEN, ...) should throw a
 * ProblemException with that code instead of falling through to these.
 */
const FallbackCode = {
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

interface Resolved {
  status: number;
  code: string;
  title: string;
  extra?: Record<string, unknown>;
}

function toKebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/** mysql2 error shape surfaced through TypeORM's QueryFailedError.driverError */
interface MysqlDriverError {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId | undefined>();
    const requestId = request?.id ?? randomUUID();

    const resolved = this.resolve(exception);

    if (resolved.status >= 500) {
      this.logger.error(
        `[${requestId}] ${resolved.code}: ${resolved.title}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // 26-backend-code-review.md Task 2: a route-independent backstop, not
    // just CacheInterceptor's own fix (which only covers the routes it
    // wraps). Any handler anywhere in the app that throws must never have
    // its error response cached — a stale 404 for a slug about to be
    // published, or a stale 500 from a database blip, would otherwise be
    // served by a CDN for as long as whatever Cache-Control a previous
    // response (or no response at all) left standing.
    if (resolved.status >= 400) {
      response.setHeader('Cache-Control', 'no-store');
    }

    response
      .status(resolved.status)
      .type('application/problem+json')
      .json({
        type: `https://safeer-sa.org/errors/${toKebab(resolved.code)}`,
        title: resolved.title,
        status: resolved.status,
        code: resolved.code,
        requestId,
        ...resolved.extra,
      });
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof ProblemException) {
      const body = exception.getResponse() as { title: string };
      return {
        status: exception.getStatus(),
        code: exception.code,
        title: body.title,
        extra: exception.extra,
      };
    }

    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as { issues?: unknown[] } | undefined;
      return {
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        title: 'Request validation failed',
        extra: zodError?.issues ? { issues: zodError.issues } : undefined,
      };
    }

    if (exception instanceof QueryFailedError) {
      const driverError = (exception as unknown as { driverError?: MysqlDriverError }).driverError;
      if (driverError?.code === 'ER_ROW_IS_REFERENCED_2' || driverError?.errno === 1451) {
        // The backstop for RESTRICT foreign keys (trap 3). Modules that can
        // produce this in normal operation (media delete, P7) catch it
        // earlier and return a proper ASSET_IN_USE with a usage list; this
        // is only reached for a path that did not.
        return { status: 409, code: FallbackCode.CONFLICT, title: 'This item is referenced elsewhere and cannot be deleted' };
      }
      if (driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062) {
        return { status: 409, code: FallbackCode.CONFLICT, title: 'A record with that value already exists' };
      }
      return { status: 500, code: FallbackCode.INTERNAL_ERROR, title: 'Database error' };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const title = this.extractTitle(exception);
      return { status, code: this.codeForStatus(status), title };
    }

    return {
      status: 500,
      code: FallbackCode.INTERNAL_ERROR,
      title: 'An unexpected error occurred',
    };
  }

  private extractTitle(exception: HttpException): string {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    if (typeof body === 'object' && body !== null) {
      const message = (body as { message?: string | string[] }).message;
      if (Array.isArray(message)) return message.join('; ');
      if (typeof message === 'string') return message;
    }
    return exception.message;
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case 400:
      case 422:
        return ErrorCode.VALIDATION_FAILED;
      case 401:
        return ErrorCode.UNAUTHENTICATED;
      case 403:
        return ErrorCode.FORBIDDEN;
      case 404:
        return ErrorCode.NOT_FOUND;
      case 409:
        return FallbackCode.CONFLICT;
      case 429:
        return ErrorCode.RATE_LIMITED;
      default:
        return status >= 500 ? FallbackCode.INTERNAL_ERROR : FallbackCode.CONFLICT;
    }
  }
}
