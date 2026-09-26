// C19: UTF-8 upload names and RFC 5987 Content-Disposition.
import { contentDisposition, decodeUploadName } from '../../src/common/http/filenames.js';

const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

describe('decodeUploadName (C19)', () => {
  it('re-decodes a latin1-mangled Arabic name', () => {
    expect(decodeUploadName(latin1('شهادة التخرج.pdf'))).toBe('شهادة التخرج.pdf');
  });
  it('keeps plain ASCII and already-correct names', () => {
    expect(decodeUploadName('scan.pdf')).toBe('scan.pdf');
    expect(decodeUploadName('شهادة.pdf')).toBe('شهادة.pdf');
  });
  it('drops control characters and falls back to "file"', () => {
    expect(decodeUploadName('a\r\nb.pdf')).toBe('ab.pdf');
    expect(decodeUploadName('')).toBe('file');
  });
});

describe('contentDisposition (C19)', () => {
  it('has an ASCII fallback plus filename*=UTF-8', () => {
    const header = contentDisposition('inline', 'شهادة.pdf');
    expect(header).toBe(`inline; filename="_____.pdf"; filename*=UTF-8''${encodeURIComponent('شهادة')}.pdf`);
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
  });
  it('strips quotes and line breaks', () => {
    expect(contentDisposition('attachment', 'a"b\r\n.pdf')).toBe(`attachment; filename="ab.pdf"; filename*=UTF-8''ab.pdf`);
  });
});
