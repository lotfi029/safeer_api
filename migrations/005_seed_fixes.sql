-- 005_seed_fixes.sql
-- safeer-backend-fr-review.md B9. Fixes bad data already written by
-- 002_seed.sql on any database migrated before this file existed. A
-- database migrated fresh (with 002_seed.sql already carrying the fixed
-- values, via tools/seed-from-prototype.mjs's own matching update) sees
-- these as no-ops.

-- The featured testimonial still carries the "[يُستكمل النص الكامل...]"
-- placeholder bracket (kept verbatim per the project plan, never invented
-- real content) but was seeded 'published'/featured, so it would show on
-- the live home page. Matched by the placeholder text itself, not an
-- assumed id — robust regardless of insert order.
UPDATE testimonials
SET status = 'pending', is_featured = 0
WHERE quote_ar LIKE '%يُستكمل النص الكامل%'
  AND (status <> 'pending' OR is_featured <> 0);

-- Section button URLs were the prototype's own hash routes (#/apply,
-- #/about, ...); the Next.js frontend expects a locale-agnostic path (it
-- prepends /{locale} itself). Checked against the prototype's own route
-- list (ROUTES, safeer-prototype.html ~line 1971) — these 7 are the only
-- hash routes 002_seed.sql's page_sections ever used.
UPDATE page_sections SET primary_button_url = '/apply' WHERE primary_button_url = '#/apply';
UPDATE page_sections SET primary_button_url = '/about' WHERE primary_button_url = '#/about';
UPDATE page_sections SET primary_button_url = '/work-areas' WHERE primary_button_url = '#/work';
UPDATE page_sections SET primary_button_url = '/scholarships' WHERE primary_button_url = '#/scholarships';
UPDATE page_sections SET primary_button_url = '/news' WHERE primary_button_url = '#/news';
UPDATE page_sections SET primary_button_url = '/partners' WHERE primary_button_url = '#/partners';
UPDATE page_sections SET primary_button_url = '/contact' WHERE primary_button_url = '#/contact';

UPDATE page_sections SET secondary_button_url = '/apply' WHERE secondary_button_url = '#/apply';
UPDATE page_sections SET secondary_button_url = '/about' WHERE secondary_button_url = '#/about';
UPDATE page_sections SET secondary_button_url = '/work-areas' WHERE secondary_button_url = '#/work';
UPDATE page_sections SET secondary_button_url = '/scholarships' WHERE secondary_button_url = '#/scholarships';
UPDATE page_sections SET secondary_button_url = '/news' WHERE secondary_button_url = '#/news';
UPDATE page_sections SET secondary_button_url = '/partners' WHERE secondary_button_url = '#/partners';
UPDATE page_sections SET secondary_button_url = '/contact' WHERE secondary_button_url = '#/contact';
