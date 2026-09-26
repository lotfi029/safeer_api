/**
 * Normalises a phone number to E.164, defaulting to `+966` (Saudi Arabia)
 * for a local number with no country code (B2, safeer-backend-fr-review.md).
 * The same rules are applied a second time, in SQL, by
 * `migrations/004_otp_channels_and_phone.sql`'s backfill of
 * `applications.phone_e164` — keep the two in sync if either changes.
 *
 * Accepts:
 *   - `05XXXXXXXX` / `5XXXXXXXX`         → `+9665XXXXXXXX` (local, no `0`/`+`)
 *   - `00966XXXXXXXXX` / `966XXXXXXXXX`  → `+966XXXXXXXXX`
 *   - `+<country><number>`               → passed through once cleaned
 * Returns `null` for anything that doesn't end up matching E.164
 * (`+` followed by 8–15 digits, first digit 1-9).
 */
const E164_RE = /^\+[1-9]\d{7,14}$/;

// Arabic-Indic (٠-٩) and Extended Arabic-Indic / Persian (۰-۹) digits, in order.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicIndex !== -1) return String(arabicIndex);
    const persianIndex = PERSIAN_DIGITS.indexOf(ch);
    return persianIndex !== -1 ? String(persianIndex) : ch;
  });
}

export function normalizePhone(raw: string | null | undefined, defaultCc = '966'): string | null {
  if (!raw) return null;

  let value = toAsciiDigits(raw).replace(/[\s\-.()]/g, '');
  if (!value) return null;

  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }

  if (/^0\d+$/.test(value)) {
    // Local number with a trunk `0` (e.g. 05XXXXXXXX) — drop the `0`, prefix the default country code.
    value = `+${defaultCc}${value.slice(1)}`;
  } else if (/^5\d{8}$/.test(value)) {
    // Bare Saudi mobile with no leading 0 or country code.
    value = `+${defaultCc}${value}`;
  } else if (/^\d/.test(value)) {
    // Digits with no `+` and no leading 0 — assume a country code is already present.
    value = `+${value}`;
  }

  return E164_RE.test(value) ? value : null;
}
