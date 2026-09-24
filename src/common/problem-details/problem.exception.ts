import { HttpException } from '@nestjs/common';
import type { ErrorCode } from './error-codes.js';

function toKebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/**
 * An exception carrying everything the RFC 7807 problem+json filter needs:
 * an HTTP status, a machine `code` and a human `title`, plus arbitrary extra
 * fields (e.g. `usages` for ASSET_IN_USE) merged into the body.
 */
export class ProblemException extends HttpException {
  readonly code: ErrorCode;
  readonly extra?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, title: string, extra?: Record<string, unknown>) {
    super({ code, title, extra }, status);
    this.code = code;
    this.extra = extra;
  }

  get typeUri(): string {
    return `https://safeer-sa.org/errors/${toKebab(this.code)}`;
  }
}
