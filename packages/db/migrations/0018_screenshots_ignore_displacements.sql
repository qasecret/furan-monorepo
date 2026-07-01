-- 0018_screenshots_ignore_displacements.sql
-- Tier 1.4: per-checkpoint `ignoreDisplacements` flag.
-- When true, the diff engine suppresses regions originating from
-- diff-dom relocateGroup ops — DOM-level "this element moved without
-- changing." Pixel-level (L1) displacement detection is a separate
-- engine pass; this column persists the per-checkpoint intent so a
-- later L1 pass can consume the same setting.
--
-- Additive non-null column with a default of FALSE: safe for existing
-- rows (back-fills with FALSE = today's behavior of NOT ignoring
-- displacements).

ALTER TABLE screenshots
  ADD COLUMN ignore_displacements boolean NOT NULL DEFAULT false;
