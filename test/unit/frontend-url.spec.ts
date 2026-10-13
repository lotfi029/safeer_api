// C2: every emailed link is a locale-prefixed frontend URL.
import { frontendUrl } from '../../src/common/links/frontend-url.js';

const env = { FRONTEND_BASE_URL: 'https://site.example' };

describe('frontendUrl (C2)', () => {
  it('builds /{locale}/{path} on FRONTEND_BASE_URL', () => {
    expect(frontendUrl(env, 'ar', 'admin/accept/tok')).toBe('https://site.example/ar/admin/accept/tok');
    expect(frontendUrl(env, 'en', '/admin/reset/tok')).toBe('https://site.example/en/admin/reset/tok');
  });
});
