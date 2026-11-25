import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * R9: a role key is a lowercase slug, 3–64 characters, starting with a
 * letter. The system keys and a few names that read as "all-powerful" are
 * reserved (RolesService refuses them).
 */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
export const RESERVED_ROLE_KEYS: readonly string[] = ['admin', 'editor', 'support', 'owner', 'root', 'system'];

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const createRoleSchema = z
  .object({
    /** Generated (`custom-<6 hex>`) when omitted. Fixed once created. */
    key: z.string().regex(ROLE_KEY_PATTERN, 'Lowercase letters, digits and hyphens, 3–64 characters, starting with a letter').optional(),
    nameAr: z.string().trim().min(1).max(120),
    nameEn: optionalText(120),
    descriptionAr: optionalText(500),
    descriptionEn: optionalText(500),
    /** Catalog keys (GET admin/permissions); closed under delete ⇒ manage ⇒ view on save. */
    permissions: z.array(z.string().max(64)).max(200),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(120).optional(),
    nameEn: optionalText(120),
    descriptionAr: optionalText(500),
    descriptionEn: optionalText(500),
    permissions: z.array(z.string().max(64)).max(200).optional(),
  })
  .strict();

export class CreateRoleDto extends createZodDto(createRoleSchema) {}
export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}
