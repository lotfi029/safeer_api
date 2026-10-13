-- 022_governance_sections.sql
-- feat/governance-contact (A6/A7): the documents register becomes the
-- governance page — sections built on the existing doc_categories and
-- documents tables — and licences get a table of their own. Forward-only,
-- MySQL 8.4.

-- 1. Section groups and per-document meta text.
ALTER TABLE doc_categories
  ADD COLUMN section_group ENUM('governance','other') NOT NULL DEFAULT 'governance' AFTER name_en;

ALTER TABLE documents
  ADD COLUMN meta_ar VARCHAR(190) NULL AFTER title_en,
  ADD COLUMN meta_en VARCHAR(190) NULL AFTER meta_ar;

-- 2. The governance categories. Existing rows keep their ids (documents
--    point at them); two are renamed. A slug is only renamed when nothing
--    already holds the new one (uq_doccat_slug), so a database where an
--    editor created it by hand keeps both rows.
UPDATE doc_categories c
LEFT JOIN (SELECT id FROM doc_categories WHERE slug = 'bylaws-policies') taken ON 1 = 1
SET c.slug = 'bylaws-policies'
WHERE c.slug = 'policies-regulations' AND taken.id IS NULL;

UPDATE doc_categories c
LEFT JOIN (SELECT id FROM doc_categories WHERE slug = 'general-assembly') taken ON 1 = 1
SET c.slug = 'general-assembly'
WHERE c.slug = 'meeting-minutes' AND taken.id IS NULL;

INSERT IGNORE INTO doc_categories (slug, name_ar, name_en, section_group, is_published, sort_order) VALUES
  ('bylaws-policies', 'اللوائح والسياسات', 'Bylaws & policies', 'governance', 1, 1),
  ('financial-reports', 'التقارير المالية', 'Financial reports', 'governance', 1, 2),
  ('general-assembly', 'الجمعية العمومية', 'General assembly', 'governance', 1, 3),
  ('strategic-plan', 'الخطة الاستراتيجية', 'Strategic plan', 'governance', 1, 4),
  ('operational-plan', 'الخطة التشغيلية', 'Operational plan', 'governance', 1, 5),
  ('annual-reports', 'التقارير السنوية', 'Annual reports', 'governance', 1, 6),
  ('project-reports', 'تقارير المشاريع', 'Project reports', 'governance', 1, 7),
  ('committees', 'اللجان', 'Committees', 'governance', 1, 8),
  ('committee-decisions', 'قرارات اللجان', 'Committee decisions', 'governance', 1, 9);

-- The names, order and visibility the owner chose, also for rows that
-- already existed (the INSERT IGNORE above skipped those).
UPDATE doc_categories SET name_ar = 'اللوائح والسياسات', name_en = 'Bylaws & policies', section_group = 'governance', is_published = 1, sort_order = 1 WHERE slug = 'bylaws-policies';
UPDATE doc_categories SET name_ar = 'التقارير المالية', name_en = 'Financial reports', section_group = 'governance', is_published = 1, sort_order = 2 WHERE slug = 'financial-reports';
UPDATE doc_categories SET name_ar = 'الجمعية العمومية', name_en = 'General assembly', section_group = 'governance', is_published = 1, sort_order = 3 WHERE slug = 'general-assembly';
UPDATE doc_categories SET name_ar = 'الخطة الاستراتيجية', name_en = 'Strategic plan', section_group = 'governance', is_published = 1, sort_order = 4 WHERE slug = 'strategic-plan';
UPDATE doc_categories SET name_ar = 'الخطة التشغيلية', name_en = 'Operational plan', section_group = 'governance', is_published = 1, sort_order = 5 WHERE slug = 'operational-plan';
UPDATE doc_categories SET name_ar = 'التقارير السنوية', name_en = 'Annual reports', section_group = 'governance', is_published = 1, sort_order = 6 WHERE slug = 'annual-reports';
UPDATE doc_categories SET name_ar = 'تقارير المشاريع', name_en = 'Project reports', section_group = 'governance', is_published = 1, sort_order = 7 WHERE slug = 'project-reports';
UPDATE doc_categories SET name_ar = 'اللجان', name_en = 'Committees', section_group = 'governance', is_published = 1, sort_order = 8 WHERE slug = 'committees';
UPDATE doc_categories SET name_ar = 'قرارات اللجان', name_en = 'Committee decisions', section_group = 'governance', is_published = 1, sort_order = 9 WHERE slug = 'committee-decisions';

-- Licences move to their own table (below); their category leaves the
-- governance sections and the public register.
UPDATE doc_categories SET section_group = 'other', is_published = 0, sort_order = 100 WHERE slug = 'licences';

-- 3. Licences (A7). At most one row is primary — kept by the admin
--    controller inside a transaction (src/licences). The primary published
--    licence's number and issuer are written through to site_settings.
CREATE TABLE licences (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title_ar    VARCHAR(191)    NOT NULL,
  title_en    VARCHAR(191)    NULL,
  number      VARCHAR(100)    NULL,
  issuer_ar   VARCHAR(190)    NULL,
  issuer_en   VARCHAR(190)    NULL,
  issued_on   DATE            NULL,
  expires_on  DATE            NULL,
  asset_id    BIGINT UNSIGNED NULL,           -- the licence document (PDF or image)
  is_primary  TINYINT(1)      NOT NULL DEFAULT 0,
  is_published TINYINT(1)     NOT NULL DEFAULT 0,
  sort_order  INT             NOT NULL DEFAULT 0,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_licences_public (is_published, is_primary, sort_order),
  KEY ix_licences_asset (asset_id),
  CONSTRAINT fk_licences_asset FOREIGN KEY (asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE site_settings
  ADD COLUMN licence_no VARCHAR(100) NULL AFTER seo_description_en,
  ADD COLUMN licence_issuer_ar VARCHAR(190) NULL AFTER licence_no,
  ADD COLUMN licence_issuer_en VARCHAR(190) NULL AFTER licence_issuer_ar;

-- The documents filed under the licences category become licences: title,
-- file and visibility carry over; number, issuer and dates are left for an
-- editor to fill in. None is made primary — an editor picks it
-- (PATCH admin/licences/:id/primary). Then the document rows go, so a
-- licence isn't listed twice in the dashboard; the file itself stays (the
-- licence now references it).
INSERT INTO licences (title_ar, title_en, asset_id, is_published, sort_order, created_at)
SELECT d.title_ar, d.title_en, d.asset_id, d.is_published, d.sort_order, d.created_at
FROM documents d JOIN doc_categories c ON c.id = d.category_id
WHERE c.slug = 'licences'
ORDER BY d.sort_order, d.id;

DELETE d FROM documents d JOIN doc_categories c ON c.id = d.category_id WHERE c.slug = 'licences';

-- 4. The governance page (its title is the nav label; GET /site lists it in
--    place of `documents`, which stays as a page but leaves the nav).
INSERT IGNORE INTO pages (slug, title_ar, title_en, meta_title_ar, meta_title_en, meta_description_ar, meta_description_en, is_published, needs_review) VALUES
  ('governance', 'الحوكمة', 'Governance', 'الحوكمة', 'Governance',
   'لوائح الجمعية وسياساتها وتقاريرها ومحاضر جمعيتها العمومية وتراخيصها.',
   'The association\'s bylaws, policies, reports, general assembly records and licences.', 1, 0);
