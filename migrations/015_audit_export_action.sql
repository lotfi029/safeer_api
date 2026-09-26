-- 015_audit_export_action.sql
-- safeer-backend-code-review.md C36: a CSV export of applications (personal
-- data leaving the system) is audited, with its filters and row count.
ALTER TABLE audit_log
  MODIFY action ENUM('create','update','delete','publish','unpublish','login','login_failed','upload','export') NOT NULL;
