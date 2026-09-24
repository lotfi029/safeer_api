import type { ValueTransformer } from 'typeorm';

/**
 * DECIMAL columns through a JS number lose money (13-backend-build-plan.md
 * trap 6). Used on `amount_sar` and `price_sar` from the start — the DB
 * value is always read and written as a string.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value: string | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : String(value)),
};
