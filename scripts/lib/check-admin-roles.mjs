// scripts/lib/check-admin-roles.mjs
//
// B4/B5 sweep (safeer-backend-fr-review.md phase 2): every route under
// admin/* must require a role, or a reviewer/support/editor account can
// reach it with nothing but a valid staff session (exactly the bugs B4 —
// RedirectsController — and B5 — MediaController — were). This walks every
// controller Nest actually registered (via ModulesContainer, not a
// source-text grep) and fails on any admin/* route that:
//   - is not @Public(), and
//   - has no @Roles() metadata (class- or method-level — RolesGuard's own
//     `getAllAndOverride` lookup), and
//   - isn't on the explicit allow-list below.
//
// The allow-list matches the review's own wording exactly: admin/me,
// admin/auth/*, admin/overview, admin/preview-token — routes that are
// intentionally "any signed-in staff member", not role-gated.
//
// Exported as a pure function of a running INestApplication so it can be
// used both by scripts/check-admin-roles.mjs (no test runner needed) and by
// a real Jest test once Phase 6 adds one (test/permissions.spec.ts).

import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container.js';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { ROLES_KEY } from '../../dist/auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from '../../dist/auth/decorators/public.decorator.js';

const ALLOW_LIST = [
  /^admin\/me$/,
  /^admin\/auth(\/.*)?$/,
  /^admin\/overview$/,
  /^admin\/preview-token(\/.*)?$/,
];

function isAllowed(fullPath) {
  return ALLOW_LIST.some((re) => re.test(fullPath));
}

function joinPaths(...segments) {
  return segments
    .map((s) => String(s ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * Every method reachable on `instance`, walking the whole prototype chain
 * (stopping at `Object.prototype`) — not just its own class's methods.
 * Most CRUD content controllers (RedirectsController included) extend the
 * class `CrudController<E>()` returns and never override `list`/`create`/
 * `update`/`remove`, so those handlers live on that generated base class,
 * not on the subclass's own prototype. The closest override wins, exactly
 * like normal JS method resolution (and exactly what Nest actually calls at
 * request time).
 */
function collectHandlers(instance) {
  const handlers = new Map();
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || handlers.has(name)) continue;
      const fn = proto[name];
      if (typeof fn === 'function') handlers.set(name, fn);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return handlers;
}

/**
 * @param {import('@nestjs/common').INestApplication} app
 * @returns {{ path: string; controller: string; method: string }[]} violations
 */
export function findUnroledAdminRoutes(app) {
  const reflector = app.get(Reflector);
  const modulesContainer = app.get(ModulesContainer);
  const violations = [];

  for (const module of modulesContainer.values()) {
    for (const wrapper of module.controllers.values()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype);
      if (typeof controllerPath !== 'string') continue;

      for (const [methodName, handler] of collectHandlers(instance)) {
        // Only actual HTTP route handlers carry METHOD_METADATA (set by @Get/@Post/etc).
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;

        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) ?? '';
        const fullPath = joinPaths(controllerPath, methodPath);
        if (!/^admin(\/|$)/.test(fullPath)) continue;
        if (isAllowed(fullPath)) continue;

        const isPublic = reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, metatype]);
        if (isPublic) continue;

        const roles = reflector.getAllAndOverride(ROLES_KEY, [handler, metatype]);
        if (!roles || roles.length === 0) {
          violations.push({ path: fullPath, controller: metatype.name, method: methodName });
        }
      }
    }
  }

  return violations;
}
