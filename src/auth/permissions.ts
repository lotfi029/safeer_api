import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

/**
 * PERM-2: the permission catalog — the one list of what a role can hold.
 *
 * A permission is `<module>.<action>`:
 *   - `view`   — list and read
 *   - `manage` — create, edit, publish, reorder, upload
 *   - `delete` — delete
 * `delete` implies `manage` and `manage` implies `view`, where the module has
 * them (normalisePermissions()). Each module lists only the actions its
 * routes actually have: audit is read-only, mail has nothing to delete,
 * newsletter subscribers are read and deleted but never edited.
 *
 * The `admin` system role holds the wildcard `*` instead of a list.
 * scripts/lib/check-permissions.mjs fails CI on any admin route whose
 * `@Permission()` is not in this catalog, or whose action doesn't match its
 * HTTP method.
 */
export const WILDCARD = '*';

export const PERMISSION_ACTIONS = ['view', 'manage', 'delete'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

const VMD = ['view', 'manage', 'delete'] as const;

export const PERMISSION_GROUPS = [
  {
    key: 'content',
    labelAr: 'المحتوى',
    labelEn: 'Content',
    modules: [
      { key: 'pages', labelAr: 'الصفحات', labelEn: 'Pages', actions: VMD },
      { key: 'news', labelAr: 'الأخبار وتصنيفاتها', labelEn: 'News and categories', actions: VMD },
      { key: 'workAreas', labelAr: 'مجالات العمل', labelEn: 'Work areas', actions: VMD },
      { key: 'board', labelAr: 'مجلس الإدارة', labelEn: 'Board', actions: VMD },
      { key: 'orgChart', labelAr: 'الهيكل التنظيمي', labelEn: 'Org chart', actions: VMD },
      { key: 'partners', labelAr: 'الشركاء', labelEn: 'Partners', actions: VMD },
      { key: 'documents', labelAr: 'الوثائق وتصنيفاتها', labelEn: 'Documents and categories', actions: VMD },
      { key: 'licences', labelAr: 'التراخيص', labelEn: 'Licences', actions: VMD },
      { key: 'stats', labelAr: 'الإحصاءات', labelEn: 'Stats', actions: VMD },
      { key: 'aboutItems', labelAr: 'عناصر من نحن', labelEn: 'About items', actions: VMD },
      { key: 'media', labelAr: 'مكتبة الوسائط', labelEn: 'Media', actions: VMD },
      { key: 'redirects', labelAr: 'التحويلات', labelEn: 'Redirects', actions: VMD },
    ],
  },
  {
    key: 'inbox',
    labelAr: 'الوارد',
    labelEn: 'Inbox',
    modules: [
      { key: 'messages', labelAr: 'الرسائل', labelEn: 'Messages', actions: VMD },
      { key: 'testimonials', labelAr: 'الشهادات ومحاورها', labelEn: 'Testimonials and themes', actions: VMD },
      { key: 'newsletter', labelAr: 'النشرة البريدية', labelEn: 'Newsletter', actions: ['view', 'delete'] },
    ],
  },
  {
    key: 'system',
    labelAr: 'النظام',
    labelEn: 'System',
    modules: [
      { key: 'users', labelAr: 'المستخدمون', labelEn: 'Users', actions: VMD },
      { key: 'roles', labelAr: 'الأدوار والصلاحيات', labelEn: 'Roles', actions: VMD },
      { key: 'settings', labelAr: 'إعدادات الموقع والذاكرة المؤقتة', labelEn: 'Site settings and cache', actions: VMD },
      { key: 'mail', labelAr: 'البريد', labelEn: 'Mail', actions: ['view', 'manage'] },
      { key: 'audit', labelAr: 'سجل التدقيق', labelEn: 'Audit log', actions: ['view'] },
    ],
  },
] as const satisfies readonly {
  key: string;
  labelAr: string;
  labelEn: string;
  modules: readonly { key: string; labelAr: string; labelEn: string; actions: readonly PermissionAction[] }[];
}[];

type Group = (typeof PERMISSION_GROUPS)[number];
type Module = Group['modules'][number];
export type PermissionModule = Module['key'];
export type PermissionKey = Module extends infer M
  ? M extends { key: infer K extends string; actions: readonly (infer A extends string)[] }
    ? `${K}.${A}`
    : never
  : never;

const MODULE_ACTIONS: ReadonlyMap<string, readonly PermissionAction[]> = new Map(
  PERMISSION_GROUPS.flatMap((g) => g.modules.map((m) => [m.key, m.actions as readonly PermissionAction[]] as const)),
);

/** Every key in the catalog, in catalog order. */
export const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSION_GROUPS.flatMap((g) =>
  g.modules.flatMap((m) => m.actions.map((a) => `${m.key}.${a}` as PermissionKey)),
);

const KNOWN = new Set<string>(ALL_PERMISSIONS);

export function isPermissionKey(value: string): value is PermissionKey {
  return KNOWN.has(value);
}

/** The module and action of a catalog key (undefined for anything else). */
export function splitPermission(key: string): { module: string; action: PermissionAction } | undefined {
  if (!KNOWN.has(key)) return undefined;
  const dot = key.lastIndexOf('.');
  return { module: key.slice(0, dot), action: key.slice(dot + 1) as PermissionAction };
}

/**
 * Validates a requested permission list and closes it under the implications
 * (delete ⇒ manage ⇒ view, where the module has them). Unknown keys, the
 * wildcard and actions a module doesn't have are refused with one 400 that
 * lists them all. The result is deduplicated and in catalog order.
 */
export function normalisePermissions(keys: readonly string[]): PermissionKey[] {
  const unknown = keys.filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) {
    throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `Unknown permission(s): ${[...new Set(unknown)].join(', ')}`, {
      errors: [...new Set(unknown)].map((k) => ({ path: 'permissions', message: `Unknown permission: ${k}` })),
    });
  }
  const out = new Set<string>(keys);
  for (const key of keys) {
    const { module, action } = splitPermission(key)!;
    const actions = MODULE_ACTIONS.get(module)!;
    const idx = PERMISSION_ACTIONS.indexOf(action);
    for (const implied of PERMISSION_ACTIONS.slice(0, idx)) {
      if (actions.includes(implied)) out.add(`${module}.${implied}`);
    }
  }
  return ALL_PERMISSIONS.filter((k) => out.has(k));
}

/** `*` holds everything; otherwise an exact match. */
export function can(perms: ReadonlySet<string> | readonly string[], key: string): boolean {
  const set = perms instanceof Set ? perms : new Set(perms as readonly string[]);
  return set.has(WILDCARD) || set.has(key);
}

/**
 * Whether `caller` holds everything in `target` — the no-escalation test for
 * granting, assigning and editing roles. A wildcard caller covers anything;
 * a wildcard target is covered only by a wildcard caller.
 */
export function isSubset(caller: ReadonlySet<string> | readonly string[], target: ReadonlySet<string> | readonly string[]): boolean {
  const c = caller instanceof Set ? caller : new Set(caller as readonly string[]);
  if (c.has(WILDCARD)) return true;
  for (const key of target) {
    if (!c.has(key)) return false;
  }
  return true;
}

export interface PermissionCatalog {
  actions: readonly PermissionAction[];
  groups: {
    key: string;
    labelAr: string;
    labelEn: string;
    modules: { key: string; labelAr: string; labelEn: string; actions: PermissionAction[] }[];
  }[];
}

/** `GET admin/permissions`. */
export function permissionCatalog(): PermissionCatalog {
  return {
    actions: [...PERMISSION_ACTIONS],
    groups: PERMISSION_GROUPS.map((g) => ({
      key: g.key,
      labelAr: g.labelAr,
      labelEn: g.labelEn,
      modules: g.modules.map((m) => ({ key: m.key, labelAr: m.labelAr, labelEn: m.labelEn, actions: [...m.actions] })),
    })),
  };
}
