-- 023_org_chart.sql
-- feat/org-chart: the association's organisational structure («الهيكل
-- التنظيمي»), ported from ta3lom's job-title chart. A tree of positions
-- (each reports to its parent), drawn on /about/org-structure; a board or
-- executive member can hold one position, and a position shows the names of
-- the published members who hold it. Additive, forward-only, MySQL 8.4.

CREATE TABLE org_positions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name_ar      VARCHAR(190)    NOT NULL,
  name_en      VARCHAR(190)    NULL,
  parent_id    BIGINT UNSIGNED NULL,           -- the position this one reports to
  tone         ENUM('auto','neutral','sky','green','brand') NOT NULL DEFAULT 'auto',
  show_holders TINYINT(1)      NOT NULL DEFAULT 1,
  is_published TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order   INT             NOT NULL DEFAULT 0,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_org_positions_tree (parent_id, sort_order),
  CONSTRAINT fk_org_positions_parent FOREIGN KEY (parent_id) REFERENCES org_positions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE board_members
  ADD COLUMN org_position_id BIGINT UNSIGNED NULL AFTER grp,
  ADD KEY ix_board_org_position (org_position_id),
  ADD CONSTRAINT fk_board_org_position FOREIGN KEY (org_position_id) REFERENCES org_positions (id) ON DELETE RESTRICT;
