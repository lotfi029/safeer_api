// C10: stored URLs are limited to safe schemes (and site paths where allowed).
import { safeUrl } from '../../src/common/validation/safe-url.js';

describe('safeUrl (C10)', () => {
  const abs = safeUrl();
  const rel = safeUrl({ relative: true });

  it.each(['https://example.org', 'http://example.org/x?y=1', 'mailto:info@example.org', 'tel:+966500000000'])('accepts %s', (v) => {
    expect(abs.safeParse(v).success).toBe(true);
    expect(rel.safeParse(v).success).toBe(true);
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'https:/\\evil', 'ftp://x', 'not a url'])(
    'rejects %j everywhere',
    (v) => {
      expect(abs.safeParse(v).success).toBe(false);
      expect(rel.safeParse(v).success).toBe(false);
    },
  );

  it('accepts a site path only where relative is allowed', () => {
    expect(rel.safeParse('/apply').success).toBe(true);
    expect(abs.safeParse('/apply').success).toBe(false);
    expect(rel.safeParse('//evil.example/apply').success).toBe(false);
  });
});
