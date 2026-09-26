// C5: CSV formula injection is neutralised.
import { escapeCsvField, toCsv } from '../../src/common/csv.js';

describe('escapeCsvField (C5)', () => {
  it.each([
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`],
    ['+1+1', `"'+1+1"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\t=cmd', `"'\t=cmd"`],
    ['\r=cmd', `"'\r=cmd"`],
  ])('prefixes and quotes %j', (raw, expected) => {
    expect(escapeCsvField(raw)).toBe(expected);
  });

  it.each([
    ['محمد', 'محمد'],
    ['Riyadh University', 'Riyadh University'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['user@example.com', 'user@example.com'],
  ])('leaves ordinary values alone: %j', (raw, expected) => {
    expect(escapeCsvField(raw)).toBe(expected);
  });

  it('applies to every cell of an export', () => {
    expect(toCsv([{ n: '=1+1' }], [{ header: 'Name', value: (r) => r.n }])).toBe(`Name\r\n"'=1+1"`);
  });
});
