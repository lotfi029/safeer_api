/** What a sensitive template variable (an OTP code) is replaced with in mail_log / sms_log (C1). */
export const MASKED_VALUE = '••••••';

/** `vars` with every key in `sensitive` replaced by MASKED_VALUE — the copy that may be written to a log. */
export function maskVars(vars: Record<string, string>, sensitive: readonly string[] | undefined): Record<string, string> {
  if (!sensitive?.length) return vars;
  const masked = { ...vars };
  for (const key of sensitive) {
    if (key in masked) masked[key] = MASKED_VALUE;
  }
  return masked;
}
