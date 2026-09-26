-- 010_newsletter_optin_and_retention.sql
-- safeer-backend-code-review.md C27 (and C43/C46, which touch the same
-- retention paths).

-- C27: double opt-in. A subscription counts only once confirmed through the
-- emailed link. Rows from before this change predate the requirement and
-- are treated as confirmed at the time they subscribed.
ALTER TABLE newsletter_subscribers
  ADD COLUMN confirmed_at DATETIME(3) NULL AFTER locale;
UPDATE newsletter_subscribers SET confirmed_at = created_at WHERE confirmed_at IS NULL;

-- C46: a reply's delivery status survives mail_log's 90-day purge (which
-- nulls message_replies.mail_log_id): the nightly job copies it here first.
ALTER TABLE message_replies
  ADD COLUMN delivery_status ENUM('queued','sent','failed','skipped') NULL AFTER mail_log_id;
UPDATE message_replies r JOIN mail_log m ON m.id = r.mail_log_id SET r.delivery_status = m.status;

-- C43: the retention jobs and the admin lists filter/sort on created_at.
ALTER TABLE applications ADD KEY ix_applications_created (created_at);
ALTER TABLE mail_log ADD KEY ix_mail_log_created (created_at);
ALTER TABLE sms_log ADD KEY ix_sms_log_created (created_at);
ALTER TABLE contact_messages ADD KEY ix_contact_messages_created (created_at);

-- C27: DELETE /admin/applications/:id anonymises an application — the
-- personal fields are cleared and its files and history removed, while the
-- row (reference, status, dates) stays for the statistics.
ALTER TABLE applications ADD COLUMN anonymized_at DATETIME(3) NULL AFTER decided_at;
