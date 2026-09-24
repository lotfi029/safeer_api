-- 001_schema.sql
-- Every table the ported infrastructure entities map to (accounts, files,
-- mail, redirects), plus every table the Safeer domain (SMS, site, content,
-- voices/partners, documents, inbox, scholarships) needs — see the project
-- plan's "Data model" section for the source of truth this was transcribed
-- from. `schema_migrations` and `typeorm_metadata` are created by
-- scripts/migrate.mjs itself, not here.
--
-- Conventions, carried over from african_api's 001_schema.sql: BIGINT
-- UNSIGNED AUTO_INCREMENT ids (strings in TypeScript), DATETIME(3) with
-- CURRENT_TIMESTAMP(3) defaults, named uq_/ix_/fk_ constraints,
-- ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- (unicode_ci everywhere — see database.module.ts, which this file's
-- collation MUST match), xxx_ar NOT NULL / xxx_en NULL bilingual pairs, and
-- no soft deletes anywhere.
--
-- Tables are grouped under the plan's own `-- 3.x` section numbers, but a
-- few tables are created earlier than their section suggests because a
-- later section's table has a foreign key into them (MySQL requires the
-- referenced table to already exist) — noted inline where it happens.

-- ===================================================================
-- 3.1 Accounts
-- ===================================================================

CREATE TABLE users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(120)    NOT NULL,
  email          VARCHAR(191)    NOT NULL,
  password_hash  VARCHAR(255)    NOT NULL,           -- Argon2id
  role           ENUM('admin','reviewer','editor','support') NOT NULL DEFAULT 'editor',
  is_locked      TINYINT(1)      NOT NULL DEFAULT 0, -- set after repeated failed sign-ins
  failed_logins  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_login_at  DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (                              -- staff cookie: sf_sid
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)        NOT NULL,           -- SHA-256 of the 32-byte cookie value
  expires_at     DATETIME(3)     NOT NULL,           -- absolute: created_at + 30 days
  last_seen_at   DATETIME(3)     NOT NULL,           -- idle timeout measured from here (8 h)
  revoked_at     DATETIME(3)     NULL,
  user_agent     VARCHAR(255)    NULL,
  ip_hash        CHAR(64)        NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_hash (token_hash),
  KEY ix_session_user (user_id, revoked_at, expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE auth_tokens (                           -- invitations and password resets
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('invite','reset') NOT NULL,
  token_hash  CHAR(64)        NOT NULL,
  expires_at  DATETIME(3)     NOT NULL,              -- invite 48 h, reset 60 min
  used_at     DATETIME(3)     NULL,                  -- single use
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_authtok_hash (token_hash),
  KEY ix_authtok_user (user_id, purpose, used_at),
  CONSTRAINT fk_authtok_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (                             -- append-only: the app DB user gets only SELECT/INSERT
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id     BIGINT UNSIGNED NULL,
  action       ENUM('create','update','delete','publish','unpublish','login','login_failed','upload') NOT NULL,
  entity_type  VARCHAR(64)     NOT NULL,       -- applications, users, posts …
  entity_id    BIGINT UNSIGNED NULL,
  entity_label VARCHAR(255)    NULL,           -- human title at the time of the action
  diff         JSON            NULL,           -- {before, after} — full snapshot on delete
  ip_hash      CHAR(64)        NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_recent (created_at DESC),
  KEY ix_audit_entity (entity_type, entity_id, created_at DESC),
  CONSTRAINT fk_audit_user FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.2 Files
-- ===================================================================

CREATE TABLE media_assets (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(36)        NOT NULL,            -- used in /files/:public_id
  kind           ENUM('image','pdf') NOT NULL,
  mime_type      VARCHAR(100)    NOT NULL,
  size_bytes     INT UNSIGNED    NOT NULL,
  original_name  VARCHAR(255)    NOT NULL,
  storage_key    VARCHAR(255)    NOT NULL,            -- assets/2026/09/<uuid>.webp
  checksum_sha256 CHAR(64)       NOT NULL,            -- duplicate detection
  width_px       SMALLINT UNSIGNED NULL,
  height_px      SMALLINT UNSIGNED NULL,
  alt_ar         VARCHAR(255)    NULL,                -- required before an image may be attached
  alt_en         VARCHAR(255)    NULL,
  uploaded_by    BIGINT UNSIGNED NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_assets_public (public_id),
  UNIQUE KEY uq_assets_checksum (checksum_sha256),
  KEY ix_assets_kind (kind, created_at),
  CONSTRAINT fk_assets_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE media_variants (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_id   BIGINT UNSIGNED NOT NULL,
  label      ENUM('thumb','card','full') NOT NULL,    -- 400 / 800 / 1600 px wide, WebP
  storage_key VARCHAR(255)   NOT NULL,
  width_px   SMALLINT UNSIGNED NOT NULL,
  size_bytes INT UNSIGNED    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_variant (asset_id, label),
  CONSTRAINT fk_variant_asset FOREIGN KEY (asset_id) REFERENCES media_assets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every foreign key pointing at media_assets in this file uses
-- ON DELETE RESTRICT — that is what makes "a file in use cannot be deleted"
-- a guarantee rather than a check the API might forget. Student application
-- documents are NEVER stored in media_assets (infra change §3) — they live
-- only on disk under STORAGE_ROOT/private/, referenced by
-- application_documents.storage_key with no media_assets row at all, so the
-- public /files/:publicId gate can never expose them.

-- ===================================================================
-- 3.3 Messaging — mail
-- ===================================================================

CREATE TABLE mail_settings (                   -- single row, like site_settings
  id                 BIGINT UNSIGNED NOT NULL DEFAULT 1,
  is_enabled         TINYINT(1)   NOT NULL DEFAULT 0,
  driver             ENUM('smtp','log') NOT NULL DEFAULT 'log',
  host               VARCHAR(191) NULL,
  port               SMALLINT UNSIGNED NULL,
  encryption         ENUM('none','tls','starttls') NOT NULL DEFAULT 'starttls',
  username           VARCHAR(191) NULL,
  password_encrypted VARBINARY(512) NULL,      -- AES-256-GCM under APP_ENCRYPTION_KEY; never returned by the API
  from_name_ar       VARCHAR(120) NULL,
  from_name_en       VARCHAR(120) NULL,
  from_email         VARCHAR(191) NULL,
  reply_to           VARCHAR(191) NULL,
  notify_email       VARCHAR(191) NULL,        -- receives contact notifications
  last_test_at       DATETIME(3)  NULL,
  last_test_ok       TINYINT(1)   NULL,
  last_test_error    VARCHAR(500) NULL,
  updated_by         BIGINT UNSIGNED NULL,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_mail_single CHECK (id = 1),
  CONSTRAINT fk_mail_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_templates (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`        VARCHAR(64)  NOT NULL,          -- contact_ack | contact_notify | user_invite | password_reset |
                                                -- application_started | application_submitted |
                                                -- application_status_changed | document_rejected |
                                                -- documents_requested | message_reply | otp_code
  name_ar      VARCHAR(191) NOT NULL,          -- what an editor sees in the list
  name_en      VARCHAR(191) NULL,
  subject_ar   VARCHAR(255) NOT NULL,
  subject_en   VARCHAR(255) NULL,
  body_ar      MEDIUMTEXT   NOT NULL,          -- Markdown with {{variables}}
  body_en      MEDIUMTEXT   NULL,
  variables    JSON         NOT NULL,          -- ["name","link"] — the allow-list, owned by the code
  is_enabled   TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tpl_key (`key`),
  CONSTRAINT fk_tpl_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_key  VARCHAR(64)  NOT NULL,         -- not a FK: the log outlives template deletion
  locale        ENUM('ar','en') NOT NULL DEFAULT 'ar',
  to_email      VARCHAR(191) NOT NULL,
  subject       VARCHAR(255) NOT NULL,         -- as actually rendered
  status        ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error         VARCHAR(1000) NULL,            -- the provider's own message
  payload       JSON         NULL,             -- {subject, html, text} as rendered; nulled once status reaches sent or terminal failed
  entity_type   VARCHAR(64)  NULL,             -- what triggered it: contact_messages, applications …
  entity_id     BIGINT UNSIGNED NULL,
  next_retry_at DATETIME(3)  NULL,
  sent_at       DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_mail_recent (status, created_at DESC),
  KEY ix_mail_retry (status, next_retry_at),
  KEY ix_mail_entity (entity_type, entity_id),
  KEY ix_mail_template (template_key, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.3 Messaging — SMS (Safeer infra change §4, mirrors mail above)
-- ===================================================================

CREATE TABLE sms_settings (                    -- single row, like mail_settings/site_settings
  id                BIGINT UNSIGNED NOT NULL DEFAULT 1,
  is_enabled        TINYINT(1)   NOT NULL DEFAULT 0,
  driver            ENUM('log','http') NOT NULL DEFAULT 'log',
  provider_url      VARCHAR(500) NULL,         -- 'http' driver only: a generic endpoint, no real vendor wired
  token_encrypted   VARBINARY(512) NULL,       -- AES-256-GCM under APP_ENCRYPTION_KEY; never returned by the API
  sender_name       VARCHAR(120) NULL,
  last_test_at      DATETIME(3)  NULL,
  last_test_ok      TINYINT(1)   NULL,
  last_test_error   VARCHAR(500) NULL,
  updated_by        BIGINT UNSIGNED NULL,
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_sms_settings_single CHECK (id = 1),
  CONSTRAINT fk_sms_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sms_templates (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`        VARCHAR(64)  NOT NULL,          -- otp_code | application_submitted | application_status_changed |
                                                -- documents_requested
  name_ar      VARCHAR(191) NOT NULL,
  name_en      VARCHAR(191) NULL,
  body_ar      VARCHAR(480) NOT NULL,          -- plain text with {{variables}} — no Markdown, kept short
  body_en      VARCHAR(480) NULL,
  variables    JSON         NOT NULL,          -- the allow-list, owned by the code (render-template.ts)
  is_enabled   TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sms_tpl_key (`key`),
  CONSTRAINT fk_sms_tpl_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sms_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_key  VARCHAR(64)  NOT NULL,         -- not a FK: the log outlives template deletion
  locale        ENUM('ar','en') NOT NULL DEFAULT 'ar',
  to_phone      VARCHAR(40)  NOT NULL,
  message       VARCHAR(500) NOT NULL,         -- as actually rendered
  status        ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error         VARCHAR(1000) NULL,
  payload       JSON         NULL,             -- {message} as rendered — same nulling discipline as mail_log.payload
  entity_type   VARCHAR(64)  NULL,             -- applications, applicant_otps …
  entity_id     BIGINT UNSIGNED NULL,
  next_retry_at DATETIME(3)  NULL,             -- kept for shape-parity with mail_log; the 'log'/'http' drivers
                                                -- never schedule a retry today (single-attempt, see sms.service.ts)
  sent_at       DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_sms_recent (status, created_at DESC),
  KEY ix_sms_retry (status, next_retry_at),
  KEY ix_sms_entity (entity_type, entity_id),
  KEY ix_sms_template (template_key, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.4 Site
-- ===================================================================

CREATE TABLE site_settings (                   -- single row (Safeer infra change §5)
  id                       BIGINT UNSIGNED NOT NULL DEFAULT 1,
  org_name_ar              VARCHAR(191) NOT NULL,
  org_name_en              VARCHAR(191) NULL,
  tagline_ar               VARCHAR(255) NULL,
  tagline_en               VARCHAR(255) NULL,
  footer_blurb_ar          TEXT         NULL,
  footer_blurb_en          TEXT         NULL,
  rights_line_ar           VARCHAR(255) NULL,
  rights_line_en           VARCHAR(255) NULL,
  phone                    VARCHAR(40)  NULL,
  email                    VARCHAR(191) NULL,
  address_ar               VARCHAR(255) NULL,
  address_en               VARCHAR(255) NULL,
  facebook_url             VARCHAR(255) NULL,
  instagram_url            VARCHAR(255) NULL,
  x_url                    VARCHAR(255) NULL,
  en_enabled               TINYINT(1)   NOT NULL DEFAULT 1,
  seo_title_ar             VARCHAR(191) NULL,
  seo_title_en             VARCHAR(191) NULL,
  seo_description_ar       VARCHAR(500) NULL,
  seo_description_en       VARCHAR(500) NULL,
  notify_email_on_status_change TINYINT(1) NOT NULL DEFAULT 1,
  notify_sms_on_status_change   TINYINT(1) NOT NULL DEFAULT 1,
  application_ref_prefix   VARCHAR(10)  NOT NULL DEFAULT 'SA',
  updated_by               BIGINT UNSIGNED NULL,
  updated_at               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_settings_single CHECK (id = 1),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pages (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug                  VARCHAR(191) NOT NULL,
  title_ar              VARCHAR(191) NOT NULL,
  title_en              VARCHAR(191) NULL,
  meta_title_ar         VARCHAR(191) NULL,
  meta_title_en         VARCHAR(191) NULL,
  meta_description_ar   VARCHAR(500) NULL,
  meta_description_en   VARCHAR(500) NULL,
  is_published          TINYINT(1)   NOT NULL DEFAULT 1,
  needs_review          TINYINT(1)   NOT NULL DEFAULT 0,  -- surfaced as a content alert on admin/overview
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pages_slug (slug),
  KEY ix_pages_published (is_published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE page_sections (
  id                              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  page_id                         BIGINT UNSIGNED NOT NULL,
  section_key                     VARCHAR(64)  NOT NULL,
  label_ar                        VARCHAR(191) NULL,
  label_en                        VARCHAR(191) NULL,
  heading_ar                      VARCHAR(255) NULL,
  heading_en                      VARCHAR(255) NULL,
  body_ar                         TEXT         NULL,
  body_en                         TEXT         NULL,
  primary_button_label_ar         VARCHAR(120) NULL,
  primary_button_label_en         VARCHAR(120) NULL,
  primary_button_url              VARCHAR(255) NULL,
  secondary_button_label_ar       VARCHAR(120) NULL,
  secondary_button_label_en       VARCHAR(120) NULL,
  secondary_button_url            VARCHAR(255) NULL,
  image_asset_id                  BIGINT UNSIGNED NULL,
  is_published                    TINYINT(1)   NOT NULL DEFAULT 1,  -- "visible" in the section editor
  sort_order                      INT          NOT NULL DEFAULT 0,
  created_at                      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_page_section_key (page_id, section_key),
  KEY ix_sections_page (page_id, is_published, sort_order),
  CONSTRAINT fk_sections_page FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE,
  CONSTRAINT fk_sections_image FOREIGN KEY (image_asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE redirects (                       -- legacy URLs, needed by the news slug's redirectFrom
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_path   VARCHAR(255)    NOT NULL,
  to_path     VARCHAR(255)    NOT NULL,
  status_code SMALLINT UNSIGNED NOT NULL DEFAULT 301,
  hits        INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_redirect_from (from_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.5 Content
-- ===================================================================

CREATE TABLE stats (                           -- أرقام وإحصائيات — value stays NULL until verified ("—")
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  value        BIGINT          NULL,
  label_ar     VARCHAR(120)    NOT NULL,
  label_en     VARCHAR(120)    NULL,
  sub_ar       VARCHAR(191)    NULL,
  sub_en       VARCHAR(191)    NULL,
  is_published TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order   INT             NOT NULL DEFAULT 0,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_stats_order (is_published, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE about_items (                     -- vision, mission, goals, care pillars, scholarship steps, requirements
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind         ENUM('vision','mission','goal','care_pillar','scholarship_step','requirement') NOT NULL,
  icon         VARCHAR(64)     NULL,
  title_ar     VARCHAR(191)    NOT NULL,
  title_en     VARCHAR(191)    NULL,
  body_ar      TEXT            NULL,
  body_en      TEXT            NULL,
  is_published TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order   INT             NOT NULL DEFAULT 0,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_about_kind (kind, is_published, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_areas (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  icon         VARCHAR(64)     NULL,
  title_ar     VARCHAR(191)    NOT NULL,
  title_en     VARCHAR(191)    NULL,
  is_published TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order   INT             NOT NULL DEFAULT 0,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_workareas_order (is_published, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_area_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  work_area_id BIGINT UNSIGNED NOT NULL,
  text_ar      VARCHAR(255)    NOT NULL,
  text_en      VARCHAR(255)    NULL,
  sort_order   INT             NOT NULL DEFAULT 0,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_workarea_items (work_area_id, sort_order),
  CONSTRAINT fk_workitem_area FOREIGN KEY (work_area_id) REFERENCES work_areas (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE board_members (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name_ar        VARCHAR(191)    NOT NULL,
  name_en        VARCHAR(191)    NULL,
  role_ar        VARCHAR(120)    NOT NULL,
  role_en        VARCHAR(120)    NULL,
  grp            ENUM('board','executive') NOT NULL,  -- `group` is a reserved word
  is_lead        TINYINT(1)      NOT NULL DEFAULT 0,
  photo_asset_id BIGINT UNSIGNED NULL,
  is_published   TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order     INT             NOT NULL DEFAULT 0,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_board_group (grp, is_published, sort_order),
  CONSTRAINT fk_board_photo FOREIGN KEY (photo_asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE news_categories (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(191)    NOT NULL,
  name_ar    VARCHAR(191)    NOT NULL,
  name_en    VARCHAR(191)    NULL,
  sort_order INT             NOT NULL DEFAULT 0,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_newscat_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE posts (                           -- آخر الأخبار
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug           VARCHAR(191)    NOT NULL,
  title_ar       VARCHAR(191)    NOT NULL,
  title_en       VARCHAR(191)    NULL,
  excerpt_ar     TEXT            NULL,
  excerpt_en     TEXT            NULL,
  body_ar        MEDIUMTEXT      NULL,          -- Markdown
  body_en        MEDIUMTEXT      NULL,
  category_id    BIGINT UNSIGNED NOT NULL,
  cover_asset_id BIGINT UNSIGNED NULL,          -- required before publishing, enforced in the application
  published_on   DATE            NULL,
  is_featured    TINYINT(1)      NOT NULL DEFAULT 0,
  is_legacy      TINYINT(1)      NOT NULL DEFAULT 0,  -- flags prototype "template content" for the clean-up flow
  is_published   TINYINT(1)      NOT NULL DEFAULT 0,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_posts_slug (slug),
  KEY ix_posts_feed (is_published, published_on DESC),
  KEY ix_posts_legacy (is_legacy),
  CONSTRAINT fk_posts_category FOREIGN KEY (category_id) REFERENCES news_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_posts_cover FOREIGN KEY (cover_asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT,
  CONSTRAINT fk_posts_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE newsletter_subscribers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email            VARCHAR(191)    NOT NULL,
  locale           ENUM('ar','en') NOT NULL DEFAULT 'ar',
  ip_hash          CHAR(64)        NULL,
  unsubscribed_at  DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_newsletter_email (email),
  KEY ix_newsletter_active (unsubscribed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.8 Inbox
-- (created here, ahead of 3.6/3.7, because 3.6's testimonials has a FK
-- into contact_messages — MySQL requires the referenced table to already
-- exist. message_replies also needs mail_log, already created above.)
-- ===================================================================

CREATE TABLE contact_messages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(191)    NOT NULL,
  phone      VARCHAR(40)     NULL,
  email      VARCHAR(191)    NOT NULL,
  subject    ENUM('scholarship','partnership','feedback','other') NOT NULL,
  body       TEXT            NOT NULL,
  status     ENUM('unread','read','archived') NOT NULL DEFAULT 'unread',
  locale     ENUM('ar','en') NOT NULL DEFAULT 'ar',
  ip_hash    CHAR(64)        NULL,
  user_agent VARCHAR(255)    NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_messages_inbox (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE message_replies (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id   BIGINT UNSIGNED NOT NULL,
  author_id    BIGINT UNSIGNED NULL,
  body         TEXT            NOT NULL,
  mail_log_id  BIGINT UNSIGNED NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_replies_message (message_id, created_at),
  CONSTRAINT fk_reply_message FOREIGN KEY (message_id) REFERENCES contact_messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_reply_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_reply_maillog FOREIGN KEY (mail_log_id) REFERENCES mail_log (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.6 Voices and partners
-- ===================================================================

CREATE TABLE testimonial_themes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title_ar       VARCHAR(191)    NOT NULL,
  title_en       VARCHAR(191)    NULL,
  description_ar TEXT            NULL,
  description_en TEXT            NULL,
  is_improvement TINYINT(1)      NOT NULL DEFAULT 0,
  sort_order     INT             NOT NULL DEFAULT 0,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_themes_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE testimonials (                    -- not linked to testimonial_themes — the plan lists no such FK
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  quote_ar         TEXT            NOT NULL,
  quote_en         TEXT            NULL,
  author_name      VARCHAR(191)    NOT NULL,
  author_desc_ar   VARCHAR(255)    NULL,
  author_desc_en   VARCHAR(255)    NULL,
  status           ENUM('pending','published','hidden') NOT NULL DEFAULT 'pending',
  is_featured      TINYINT(1)      NOT NULL DEFAULT 0,
  source           ENUM('manual','contact_form') NOT NULL DEFAULT 'manual',
  source_message_id BIGINT UNSIGNED NULL,
  sort_order       INT             NOT NULL DEFAULT 0,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_testimonials_status (status, is_featured, sort_order),
  CONSTRAINT fk_testimonial_message FOREIGN KEY (source_message_id) REFERENCES contact_messages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE partners (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name_ar       VARCHAR(191)    NOT NULL,
  name_en       VARCHAR(191)    NULL,
  category      ENUM('government','university','association','supporter') NOT NULL,
  url           VARCHAR(255)    NULL,
  logo_asset_id BIGINT UNSIGNED NULL,
  is_published  TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order    INT             NOT NULL DEFAULT 0,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_partners_category (category, is_published, sort_order),
  CONSTRAINT fk_partners_logo FOREIGN KEY (logo_asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.7 Documents — one table, several category pages
-- ===================================================================

CREATE TABLE doc_categories (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug         VARCHAR(64)     NOT NULL,       -- licences | policies | minutes | annual_reports
  name_ar      VARCHAR(191)    NOT NULL,
  name_en      VARCHAR(191)    NULL,
  is_published TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order   INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doccat_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id    BIGINT UNSIGNED NOT NULL,
  title_ar       VARCHAR(255)    NOT NULL,
  title_en       VARCHAR(255)    NULL,
  asset_id       BIGINT UNSIGNED NULL,         -- NULL renders as "coming soon"
  doc_date       DATE            NULL,
  download_count INT UNSIGNED    NOT NULL DEFAULT 0,
  is_published   TINYINT(1)      NOT NULL DEFAULT 0,
  sort_order     INT             NOT NULL DEFAULT 0,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_docs_register (category_id, is_published, sort_order),
  KEY ix_docs_date (category_id, doc_date DESC),
  CONSTRAINT fk_docs_cat FOREIGN KEY (category_id) REFERENCES doc_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_docs_asset FOREIGN KEY (asset_id) REFERENCES media_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 3.9 Scholarships
-- ===================================================================

CREATE TABLE applications (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference             VARCHAR(30)     NOT NULL,       -- e.g. SA-2026-00184, minted from `counters` on creation
  status                ENUM('draft','new','under_review','docs_missing','interview','accepted','rejected')
                         NOT NULL DEFAULT 'draft',
  current_step          TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- personal
  first_name            VARCHAR(120)    NULL,
  middle_name           VARCHAR(120)    NULL,
  last_name             VARCHAR(120)    NULL,
  birth_date            DATE            NULL,
  phone                 VARCHAR(40)     NULL,
  nationality           CHAR(2)         NULL,           -- ISO2
  id_number             VARCHAR(40)     NULL,
  email                 VARCHAR(191)    NULL,
  current_job           VARCHAR(191)    NULL,
  gender                ENUM('male','female') NULL,

  -- study
  university            VARCHAR(191)    NULL,
  major                 VARCHAR(191)    NULL,
  degree_level          ENUM('bachelor','master','phd') NULL,
  scholarship_note      TEXT            NULL,

  -- dates
  consent_at            DATETIME(3)     NULL,
  submitted_at          DATETIME(3)     NULL,
  decided_at            DATETIME(3)     NULL,

  assigned_reviewer_id  BIGINT UNSIGNED NULL,
  locale                ENUM('ar','en') NOT NULL DEFAULT 'ar',
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_applications_reference (reference),
  KEY ix_applications_status (status, submitted_at),
  KEY ix_applications_email (email),
  CONSTRAINT fk_applications_reviewer FOREIGN KEY (assigned_reviewer_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_documents (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id   BIGINT UNSIGNED NOT NULL,
  doc_type         ENUM('id_copy','certificate','admission_letter','other') NOT NULL,
  original_name    VARCHAR(255)    NOT NULL,
  storage_key      VARCHAR(255)    NOT NULL,     -- private/applications/<applicationId>/<uuid>.<ext> — never in media_assets
  mime             VARCHAR(100)    NOT NULL,
  size_bytes       INT UNSIGNED    NOT NULL,
  checksum         CHAR(64)        NOT NULL,
  status           ENUM('under_review','accepted','rejected') NOT NULL DEFAULT 'under_review',
  rejection_reason VARCHAR(500)    NULL,
  reviewed_by      BIGINT UNSIGNED NULL,
  reviewed_at      DATETIME(3)     NULL,
  superseded_at    DATETIME(3)     NULL,          -- set when a re-upload replaces this row's document
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_appdocs_application (application_id, doc_type, superseded_at),
  CONSTRAINT fk_appdocs_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appdocs_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_notes (                -- internal only, never visible_to_applicant
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  author_id      BIGINT UNSIGNED NULL,
  body           TEXT            NOT NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_appnotes_application (application_id, created_at),
  CONSTRAINT fk_appnotes_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appnotes_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_events (
  -- `type` is VARCHAR, not ENUM — a deliberate deviation from the plan's
  -- literal "type enum" wording (see the migration notes at the end of this
  -- file). Values so far: SUBMITTED, DOCS_RECEIVED, DOCS_REQUESTED,
  -- DOCUMENT_ACCEPTED, DOCUMENT_REJECTED, STATUS_CHANGED, NOTE_ADDED,
  -- INTERVIEW_SCHEDULED, INTERVIEW_BOOKED, DECISION_MADE — the admin
  -- applications module (phase 7) is the sole writer and owns this list.
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id      BIGINT UNSIGNED NOT NULL,
  type                VARCHAR(40)     NOT NULL,
  actor_id            BIGINT UNSIGNED NULL,        -- NULL = the applicant or the system, not staff
  visible_to_applicant TINYINT(1)     NOT NULL DEFAULT 0,
  data                JSON            NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_appevents_application (application_id, created_at),
  KEY ix_appevents_visible (application_id, visible_to_applicant, created_at),
  CONSTRAINT fk_appevents_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appevents_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE interview_slots (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  starts_at      DATETIME(3)     NOT NULL,
  ends_at        DATETIME(3)     NOT NULL,
  location_ar    VARCHAR(255)    NULL,
  location_en    VARCHAR(255)    NULL,
  application_id BIGINT UNSIGNED NULL,          -- NULL = open; set once booked, at most one application per slot
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_slot_application (application_id),
  KEY ix_slots_time (starts_at),
  CONSTRAINT fk_slots_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applicant_sessions (               -- portal cookie: sf_app_sid — kept entirely separate from `sessions`
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)        NOT NULL,      -- SHA-256 of the 32-byte cookie value (same utils as staff sessions)
  expires_at     DATETIME(3)     NOT NULL,      -- absolute: created_at + 7 days
  last_seen_at   DATETIME(3)     NOT NULL,      -- idle timeout measured from here (12 h)
  revoked_at     DATETIME(3)     NULL,
  user_agent     VARCHAR(255)    NULL,
  ip_hash        CHAR(64)        NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_appsession_hash (token_hash),
  KEY ix_appsession_application (application_id, revoked_at, expires_at),
  CONSTRAINT fk_appsession_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applicant_otps (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  code_hash      CHAR(64)        NOT NULL,      -- SHA-256 of the one-time code; the plaintext is never stored
  channel        ENUM('sms','email') NOT NULL,
  expires_at     DATETIME(3)     NOT NULL,      -- created_at + 10 minutes
  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- capped at 5
  consumed_at    DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_otp_application (application_id, consumed_at, expires_at),
  CONSTRAINT fk_otp_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE counters (                         -- e.g. key='application:2026', taken with SELECT … FOR UPDATE
  `key`  VARCHAR(64)     NOT NULL,
  value  INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- application_documents.storage_key points under
-- STORAGE_ROOT/private/applications/<applicationId>/ — a location the
-- public /files/:publicId controller never reads from and media_assets
-- never references, so a student's uploaded document can only ever be
-- streamed by a role-checked admin route or by the owning applicant's own
-- portal session (src/storage/private-file-store.service.ts).
--
-- application_events.type is VARCHAR(40), not an ENUM, which is the one
-- deliberate deviation from the data model section's literal wording
-- ("type enum") in this migration: that section names the column's shape
-- but never enumerates its values anywhere in the plan, and the actual
-- event vocabulary is owned by the admin-applications module the plan
-- explicitly defers to phase 7. Hard-coding a guessed ENUM list now would
-- either guess wrong or force a second migration the moment phase 7 needs
-- one more event type; VARCHAR with the comment above documents the
-- current call sites without blocking on them.
