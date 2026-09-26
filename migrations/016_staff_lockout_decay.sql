-- 016_staff_lockout_decay.sql
-- safeer-delivery-review.md A3 (C12 follow-up): the brute-force lock's
-- backoff never decayed, so each lock doubled up to 16 h and anyone who
-- knew an admin's email could keep that admin locked out.
--
-- From now on (AuthService.registerFailedAttempt):
--   - no single lock lasts more than 1 h (15 → 30 → 60 → 60 min);
--   - lock_count goes back to 0 once 24 h pass after the last lock;
--   - failed_logins goes back to 0 once 24 h pass without a wrong password.
-- last_failed_login_at records the last wrong password for that last rule.

ALTER TABLE users
  ADD COLUMN last_failed_login_at DATETIME(3) NULL AFTER failed_logins;

-- Counts already running keep their clock from now, rather than from an
-- unknown moment in the past.
UPDATE users SET last_failed_login_at = UTC_TIMESTAMP(3) WHERE failed_logins > 0;

-- Locks already running under the old rule end within the new 1 h cap.
UPDATE users
SET locked_until = UTC_TIMESTAMP(3) + INTERVAL 1 HOUR
WHERE locked_until > UTC_TIMESTAMP(3) + INTERVAL 1 HOUR;
