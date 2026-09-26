-- 006_low_priority_fixes.sql
-- safeer-backend-fr-review.md B11, B12, and the settings/social gap.

-- B11: work-area items get their own publish toggle, independent of the
-- parent work area's. Defaults to published (1) so every existing item
-- stays visible with no behaviour change until an editor unpublishes one.
ALTER TABLE work_area_items
  ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 1 AFTER sort_order;

-- B12: board member bios (Arabic required once set, English optional — the
-- app layer, not a NOT NULL, enforces "required once set": these columns
-- start out NULL for every existing row, same as every other bilingual
-- text column on this table).
ALTER TABLE board_members
  ADD COLUMN bio_ar TEXT NULL AFTER is_lead,
  ADD COLUMN bio_en TEXT NULL AFTER bio_ar;

-- Settings/social: 4 more social links alongside facebook_url/instagram_url/x_url.
ALTER TABLE site_settings
  ADD COLUMN youtube_url  VARCHAR(255) NULL AFTER x_url,
  ADD COLUMN linkedin_url VARCHAR(255) NULL AFTER youtube_url,
  ADD COLUMN whatsapp_url VARCHAR(255) NULL AFTER linkedin_url,
  ADD COLUMN tiktok_url   VARCHAR(255) NULL AFTER whatsapp_url;
