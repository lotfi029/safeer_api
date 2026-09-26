-- 020_site_map.sql
-- safeer-delivery-review.md A12: the spec's contact screen (§3) has a map,
-- but site_settings had nowhere to put one.
--   map_embed_url — the iframe src, validated against an allow-list of
--                   embed hosts (Google Maps embed, OpenStreetMap)
--   map_lat/lng   — the pin, for a frontend that draws its own map or a
--                   "directions" link
ALTER TABLE site_settings
  ADD COLUMN map_embed_url VARCHAR(500) NULL AFTER tiktok_url,
  ADD COLUMN map_lat DECIMAL(9,6) NULL AFTER map_embed_url,
  ADD COLUMN map_lng DECIMAL(9,6) NULL AFTER map_lat;
