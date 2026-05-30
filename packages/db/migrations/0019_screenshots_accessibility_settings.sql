-- 0019_screenshots_accessibility_settings.sql
-- Tier 2.5: per-checkpoint accessibility validation settings
-- (Eyes-parity). When set, the diff-worker runs axe-core over the
-- DOM snapshot and surfaces violations as diff_regions with
-- source = 'axe', category = 'accessibility'.
--
-- Additive nullable columns: NULL means "no accessibility check
-- requested for this checkpoint" (today's behavior).

ALTER TABLE screenshots
  ADD COLUMN accessibility_level text,
  ADD COLUMN accessibility_version text;
