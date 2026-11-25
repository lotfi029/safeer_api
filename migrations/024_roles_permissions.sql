-- 024_roles_permissions.sql
-- feat/custom-roles (PERM-1): staff permissions move from three hard-coded
-- roles (src/auth/role-matrix.ts) to roles stored in the database, each a
-- set of `<module>.<action>` permissions (src/auth/permissions.ts).
--
-- Expand-only, forward-only, MySQL 8.4:
--   - new tables `roles` and `role_permissions`;
--   - the three system roles, seeded with exactly what each could do before
--     (route by route: redirects.delete and messages.delete stay admin-only);
--   - `users.role_id`, backfilled from `users.role`, then NOT NULL;
--   - `users.role` is KEPT (now NULL-able). The app keeps writing it — the
--     system role's key, or NULL for a custom role — so the previous image
--     still runs against this schema if it has to be rolled back. A later
--     migration (025) drops it once that rollback window has closed.

CREATE TABLE roles (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_key       VARCHAR(64)     NOT NULL,
  name_ar        VARCHAR(120)    NOT NULL,
  name_en        VARCHAR(120)    NULL,
  description_ar VARCHAR(500)    NULL,
  description_en VARCHAR(500)    NULL,
  is_system      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_key (role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE role_permissions (
  role_id    BIGINT UNSIGNED NOT NULL,
  permission VARCHAR(64)     NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (role_key, name_ar, name_en, description_ar, description_en, is_system) VALUES
  ('admin',   'مدير عام',     'Admin',   'كل الصلاحيات، ولا يمكن تعديله أو حذفه.', 'Every permission; cannot be edited or deleted.', 1),
  ('editor',  'محرر محتوى',   'Editor',  'إدارة محتوى الموقع.',                     'Manages the site content.',                       1),
  ('support', 'دعم ومراسلات', 'Support', 'الرسائل والشهادات والنشرة البريدية.',      'Messages, testimonials and the newsletter.',      1);

-- admin: the wildcard.
INSERT INTO role_permissions (role_id, permission)
SELECT id, '*' FROM roles WHERE role_key = 'admin';

-- editor: today's `content` area — every content module, view/manage/delete,
-- except redirects.delete (admin-only before, admin-only now).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
JOIN (
            SELECT 'pages.view' AS permission UNION ALL SELECT 'pages.manage' UNION ALL SELECT 'pages.delete'
  UNION ALL SELECT 'news.view' UNION ALL SELECT 'news.manage' UNION ALL SELECT 'news.delete'
  UNION ALL SELECT 'workAreas.view' UNION ALL SELECT 'workAreas.manage' UNION ALL SELECT 'workAreas.delete'
  UNION ALL SELECT 'board.view' UNION ALL SELECT 'board.manage' UNION ALL SELECT 'board.delete'
  UNION ALL SELECT 'orgChart.view' UNION ALL SELECT 'orgChart.manage' UNION ALL SELECT 'orgChart.delete'
  UNION ALL SELECT 'partners.view' UNION ALL SELECT 'partners.manage' UNION ALL SELECT 'partners.delete'
  UNION ALL SELECT 'documents.view' UNION ALL SELECT 'documents.manage' UNION ALL SELECT 'documents.delete'
  UNION ALL SELECT 'licences.view' UNION ALL SELECT 'licences.manage' UNION ALL SELECT 'licences.delete'
  UNION ALL SELECT 'stats.view' UNION ALL SELECT 'stats.manage' UNION ALL SELECT 'stats.delete'
  UNION ALL SELECT 'aboutItems.view' UNION ALL SELECT 'aboutItems.manage' UNION ALL SELECT 'aboutItems.delete'
  UNION ALL SELECT 'media.view' UNION ALL SELECT 'media.manage' UNION ALL SELECT 'media.delete'
  UNION ALL SELECT 'redirects.view' UNION ALL SELECT 'redirects.manage'
) p
WHERE r.role_key = 'editor';

-- support: today's `inbox` area — messages (delete stays admin-only),
-- testimonials and their themes, newsletter subscribers (view, delete).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
JOIN (
            SELECT 'messages.view' AS permission UNION ALL SELECT 'messages.manage'
  UNION ALL SELECT 'testimonials.view' UNION ALL SELECT 'testimonials.manage' UNION ALL SELECT 'testimonials.delete'
  UNION ALL SELECT 'newsletter.view' UNION ALL SELECT 'newsletter.delete'
) p
WHERE r.role_key = 'support';

-- users.role_id: added NULL, backfilled from the enum, then required.
ALTER TABLE users ADD COLUMN role_id BIGINT UNSIGNED NULL AFTER role;

UPDATE users u JOIN roles r ON r.role_key = u.role SET u.role_id = r.id;

ALTER TABLE users
  MODIFY role_id BIGINT UNSIGNED NOT NULL,
  ADD KEY ix_users_role (role_id),
  ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT;

-- Kept for the rollback window (see the header); NULL for a custom role.
ALTER TABLE users MODIFY role ENUM('admin','editor','support') NULL DEFAULT NULL;
