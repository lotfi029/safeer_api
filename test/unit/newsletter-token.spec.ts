// C27: signed newsletter confirm / unsubscribe tokens.
import { issueNewsletterToken, verifyNewsletterToken } from '../../src/contact/newsletter-token.util.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('newsletter tokens (C27)', () => {
  it('a confirm token verifies for its own email only, until it expires', () => {
    const now = Date.now();
    const token = issueNewsletterToken(KEY, 'confirm', 'Sara@Example.com', now);
    expect(verifyNewsletterToken(KEY, 'confirm', 'sara@example.com', token, now)).toBe(true);
    expect(verifyNewsletterToken(KEY, 'confirm', 'other@example.com', token, now)).toBe(false);
    expect(verifyNewsletterToken(KEY, 'unsubscribe', 'sara@example.com', token, now)).toBe(false);
    expect(verifyNewsletterToken(KEY, 'confirm', 'sara@example.com', token, now + 8 * 24 * 3600 * 1000)).toBe(false);
  });

  it('an unsubscribe token never expires and cannot be forged', () => {
    const token = issueNewsletterToken(KEY, 'unsubscribe', 'sara@example.com');
    expect(verifyNewsletterToken(KEY, 'unsubscribe', 'sara@example.com', token, Date.now() + 10 * 365 * 24 * 3600 * 1000)).toBe(true);
    expect(verifyNewsletterToken(KEY, 'unsubscribe', 'sara@example.com', token.slice(0, -1) + 'x')).toBe(false);
    expect(verifyNewsletterToken(Buffer.alloc(32, 8).toString('base64'), 'unsubscribe', 'sara@example.com', token)).toBe(false);
  });
});
