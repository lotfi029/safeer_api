// B2: E.164 normalisation, +966 only for local 05… mobiles (aligned with 004's SQL backfill).
import { normalizePhone } from '../../src/common/phone.js';

describe('normalizePhone (B2)', () => {
  it.each([
    ['0501234567', '+966501234567'],
    ['501234567', '+966501234567'],
    ['00966501234567', '+966501234567'],
    ['966501234567', '+966501234567'],
    ['+966 50 123 4567', '+966501234567'],
    ['٠٥٠١٢٣٤٥٦٧', '+966501234567'],
    ['+201001234567', '+201001234567'],
  ])('%s → %s', (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it.each(['0112345678', '012', 'abc', ''])('rejects %j (not a 05… mobile, no country code)', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});
