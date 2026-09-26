-- 017_applicant_otp_rolling_lock.sql
-- safeer-delivery-review.md A1 (C22 follow-up).
--
-- C22 locked OTP sign-in until the next UTC day after 10 wrong codes, and
-- counted a failed verify even when no code had been issued — so 10 calls
-- with nothing but an applicant's reference locked them out for the day.
-- From now on (PortalOtpService):
--   - only a guess checked against a live code counts;
--   - 10 of those inside a rolling hour lock OTP sign-in for 1 hour
--     (otp_hour_start / otp_hour_count track the window, otp_locked_until
--     the lock);
--   - 30 in one UTC day (otp_fail_date / otp_fail_count, from 007) lock it
--     for the rest of that day.

ALTER TABLE applications
  ADD COLUMN otp_hour_start DATETIME(3) NULL AFTER otp_fail_count,
  ADD COLUMN otp_hour_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER otp_hour_start,
  ADD COLUMN otp_locked_until DATETIME(3) NULL AFTER otp_hour_count;

-- Today's counts were built under the old rule, which also counted
-- guesses against no code at all; start everyone clean.
UPDATE applications SET otp_fail_count = 0, otp_fail_date = NULL WHERE otp_fail_count > 0;
