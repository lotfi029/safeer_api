import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_SETTABLE_STATUSES } from './update-application.dto.js';
import { DOC_TYPE_VALUES } from './request-documents.dto.js';

const idsSchema = z.array(z.string().regex(/^\d+$/, 'id must be numeric')).min(1).max(200);

/**
 * `POST admin/applications/bulk` — one endpoint, three shapes, keyed by
 * `action`. This is a single flat object validated with `superRefine`
 * rather than `z.discriminatedUnion` — a discriminated union's output type
 * is a union of distinct object shapes, which `createZodDto()` can extend a
 * *class* from (TS2509: "base constructor return type ... is not an object
 * type") only when nestjs-zod resolves it to a single shape, which it
 * doesn't for a real union. `superRefine` keeps one concrete object shape
 * (with the action-specific fields optional) while still enforcing "the
 * right field is present for this action" at validation time — the field
 * that doesn't apply to a given `action` is simply never read
 * (admin-applications.service.ts's `bulkAction()`).
 */
export const bulkActionSchema = z
  .object({
    ids: idsSchema,
    action: z.enum(['assign', 'status', 'request_documents']),
    reviewerId: z.string().regex(/^\d+$/, 'reviewerId must be numeric').nullable().optional(),
    status: z.enum(ADMIN_SETTABLE_STATUSES).optional(),
    docTypes: z.array(z.enum(DOC_TYPE_VALUES)).min(1).optional(),
    message: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.action === 'assign' && val.reviewerId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'reviewerId is required for the assign action', path: ['reviewerId'] });
    }
    if (val.action === 'status' && val.status === undefined) {
      ctx.addIssue({ code: 'custom', message: 'status is required for the status action', path: ['status'] });
    }
    if (val.action === 'request_documents' && (val.docTypes === undefined || val.docTypes.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'docTypes is required for the request_documents action', path: ['docTypes'] });
    }
  });

export class BulkActionDto extends createZodDto(bulkActionSchema) {}
