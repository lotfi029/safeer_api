// scripts/lib/check-permissions.mjs
//
// PERM-3 (replaces check-admin-roles, B4/B5/B17): every route under admin/*
// must be gated by a permission from the catalog (src/auth/permissions.ts),
// or a staff account reaches it with nothing but a valid session — exactly
// the bugs B4 (RedirectsController) and B5 (MediaController) were. This
// walks every controller Nest actually registered (ModulesContainer, not a
// source-text grep) and reports any admin/* route that is not @Public() and
// either
//   - has no @Permission() and isn't on the allow-list below,
//   - names a key that isn't in the catalog, or
//   - has a first (primary) permission whose action doesn't match its HTTP
//     method: GET → view, POST/PATCH/PUT → manage, DELETE → delete.
// An allow-listed route that does carry a permission (POST admin/auth/invite
// → users.manage) is still checked.
//
// The allow-list — open to any signed-in staff member: admin/me,
// admin/auth/*, admin/overview (its blocks narrow by permission inside),
// admin/permissions (the catalog the role editor draws).
//
// Exported as a pure function of a running INestApplication, used by
// scripts/check-permissions.mjs and by Jest (test/content-security.spec.ts).

import { ModulesContainer } from '@nestjs/core/injector/modules-container.js';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../../dist/auth/decorators/permission.decorator.js';
import { IS_PUBLIC_KEY } from '../../dist/auth/decorators/public.decorator.js';
import { isPermissionKey, splitPermission } from '../../dist/auth/permissions.js';

const ALLOW_LIST = [/^admin\/me$/, /^admin\/auth(\/.*)?$/, /^admin\/overview$/, /^admin\/permissions$/];

const ACTION_FOR_METHOD = {
  [RequestMethod.GET]: 'view',
  [RequestMethod.POST]: 'manage',
  [RequestMethod.PATCH]: 'manage',
  [RequestMethod.PUT]: 'manage',
  [RequestMethod.DELETE]: 'delete',
};

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
 * Every method reachable on `instance`, walking the whole prototype chain —
 * CRUD controllers extend the class `CrudController<E>()` returns and
 * usually don't override list/get/create/update/remove, so those handlers
 * live on the generated base class. The closest override wins, as in normal
 * JS method resolution (and as Nest calls it at request time).
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
 * @returns {{ path: string; httpMethod: string; controller: string; method: string; problem: string }[]} violations
 */
export function findUngatedAdminRoutes(app) {
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
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler);
        if (requestMethod === undefined) continue;

        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) ?? '';
        const fullPath = joinPaths(controllerPath, methodPath);
        if (!/^admin(\/|$)/.test(fullPath)) continue;
        if (reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, metatype])) continue;

        const httpMethod = RequestMethod[requestMethod];
        const at = { path: fullPath, httpMethod, controller: metatype.name, method: methodName };
        const permissions = reflector.getAllAndOverride(PERMISSIONS_KEY, [handler, metatype]);
        if (!permissions || permissions.length === 0) {
          if (!isAllowed(fullPath)) violations.push({ ...at, problem: 'no @Permission()' });
          continue;
        }
        const unknown = permissions.filter((p) => !isPermissionKey(p));
        if (unknown.length > 0) {
          violations.push({ ...at, problem: `not in the permission catalog: ${unknown.join(', ')}` });
          continue;
        }
        const expected = ACTION_FOR_METHOD[requestMethod];
        const { action } = splitPermission(permissions[0]);
        if (action !== expected) {
          violations.push({ ...at, problem: `${httpMethod} needs a .${expected} permission first, got ${permissions[0]}` });
        }
      }
    }
  }

  return violations;
}
