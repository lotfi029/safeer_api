// C10: stored URLs are limited to safe schemes (and site paths where allowed).
import { mapEmbedUrl, safeUrl } from '../../src/common/validation/safe-url.js';

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

// A12: the contact-page map goes straight into an iframe — https only, and
// only the Google Maps embed endpoint or OpenStreetMap.
describe('mapEmbedUrl (A12)', () => {
  const map = mapEmbedUrl();

  it.each([
    'https://www.google.com/maps/embed?pb=!1m18!1m12',
    'https://www.google.com/maps/embed/v1/place?q=Riyadh',
    'https://www.openstreetmap.org/export/embed.html?bbox=46.6,24.6,46.8,24.8&layer=mapnik',
  ])('accepts %s', (v) => {
    expect(map.safeParse(v).success).toBe(true);
  });

  it.each([
    'http://www.google.com/maps/embed?pb=1', // not https
    'https://www.google.com/search?q=maps', // not the embed endpoint
    'https://google.com/maps/embed?pb=1', // another host
    'https://www.google.com.evil.example/maps/embed', // look-alike host
    'https://user:pw@www.google.com/maps/embed', // credentials
    'https://www.google.com:8443/maps/embed', // port
    'https://evil.example/?www.openstreetmap.org',
    'javascript:alert(1)',
    '',
  ])('rejects %j', (v) => {
    expect(map.safeParse(v).success).toBe(false);
  });
});
