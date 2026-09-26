-- 008_user_status_and_lockout.sql
-- safeer-backend-code-review.md C3, C12.
--
-- C3: `is_locked` meant both "an admin disabled this account" and "too many
-- failed sign-ins". A password reset cleared it, so a disabled user could
-- re-enable themselves through forgot-password. The two are now separate:
--   status        — the account's standing, set only by an admin (or by
--                   accepting an invitation): active | disabled | invited
--   locked_until  — C12's time-boxed brute-force lock, set only by login
--   lock_count    — how many times it has locked since the last good sign-in
--                   (the backoff exponent: 15 min × 2^lock_count)

ALTER TABLE users
  ADD COLUMN status ENUM('active','disabled','invited') NOT NULL DEFAULT 'active' AFTER role,
  ADD COLUMN locked_until DATETIME(3) NULL AFTER failed_logins,
  ADD COLUMN lock_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER locked_until;

-- A locked account could have been locked by an admin or by brute force;
-- the old column can't tell which. The safer reading: disabled, so it
-- stays out until an admin deliberately re-enables it.
UPDATE users SET status = 'disabled' WHERE is_locked = 1;

-- Never signed in and still on the unusable placeholder hash
-- (UsersService.createInvitedUser): an invitation not yet accepted.
UPDATE users
SET status = 'invited'
WHERE is_locked = 0
  AND last_login_at IS NULL
  AND password_hash = '$argon2id$v=19$m=1,t=1,p=1$AAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

-- The last counter no longer means anything once a lock can expire on its own.
UPDATE users SET failed_logins = 0;

ALTER TABLE users DROP COLUMN is_locked;
