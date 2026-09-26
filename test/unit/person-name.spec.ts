// C16: names are letters (Arabic/Latin), spaces, apostrophes and hyphens only.
import { personName } from '../../src/common/validation/person-name.js';

const schema = personName(120);

describe('personName (C16)', () => {
  it.each(['محمد', 'عبد الله', 'Anne-Marie', "O'Brien", 'José', 'أحمد بن علي', 'مُحَمَّد'])('accepts %s', (name) => {
    expect(schema.safeParse(name).success).toBe(true);
  });

  it.each(['http://evil.example', 'www.evil.example', 'me@evil.example', 'John2', '<b>x</b>', 'a/b', 'Ali.', ' ', ''])(
    'rejects %j',
    (name) => {
      expect(schema.safeParse(name).success).toBe(false);
    },
  );

  it('trims surrounding whitespace', () => {
    expect(schema.parse('  Sara  ')).toBe('Sara');
  });
});
