// C16: substituted values can't inject Markdown structure or become autolinks.
import { substituteMarkdown, substitutePlain } from '../../src/mail/render-template.js';

describe('substituteMarkdown (C16)', () => {
  it.each([
    ['http://evil.example/login', 'http\\://evil\\.example/login'],
    ['www.evil.example', 'www\\.evil\\.example'],
    ['victim@evil.example', 'victim\\@evil\\.example'],
    ['[click](http://x)', '\\[click\\]\\(http\\://x\\)'],
  ])('escapes %s in an untrusted variable', (value, expected) => {
    expect(substituteMarkdown('Hi {{name}}', { name: value })).toBe(`Hi ${expected}`);
  });

  it('leaves the code-built `link` clickable', () => {
    const out = substituteMarkdown('[{{link}}]({{link}})', { link: 'https://site.example/ar/admin/messages/1' });
    expect(out).toBe('[https://site.example/ar/admin/messages/1](https://site.example/ar/admin/messages/1)');
  });

  it('substitutePlain does not escape (text part)', () => {
    expect(substitutePlain('Hi {{name}}', { name: 'a.b' })).toBe('Hi a.b');
  });
});
