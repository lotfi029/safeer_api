import type { Env } from '../../config/env.js';
import type { Locale } from '../request-context.js';

/**
 * C2: every link sent by mail or SMS points at a page of the public
 * frontend, under its locale prefix — `${FRONTEND_BASE_URL}/{locale}/{path}`
 * — never at this API. The frontend owns these routes:
 *
 *   /{locale}/admin/accept/{token}    staff invitation
 *   /{locale}/admin/reset/{token}     staff password reset
 *   /{locale}/admin/messages/{id}     a contact message in the inbox
 *   /{locale}/portal/login            the student portal sign-in
 */
export function frontendUrl(env: Pick<Env, 'FRONTEND_BASE_URL'>, locale: Locale, path: string): string {
  const cleanPath = path.replace(/^\/+/, '');
  return `${env.FRONTEND_BASE_URL}/${locale}/${cleanPath}`;
}

export const portalLoginUrl = (env: Pick<Env, 'FRONTEND_BASE_URL'>, locale: Locale) => frontendUrl(env, locale, 'portal/login');
