-- ADR-054: the environment tuple IS the baseline identity. First dedupe any
-- variations the legacy NULL-wildcard matcher forked, then enforce the tuple as
-- a UNIQUE NULLS NOT DISTINCT constraint. Idempotent: a no-op when there are no
-- duplicates. PARTITION BY treats NULLs as equal (matching NULLS NOT DISTINCT),
-- so null os/device/branch rows collapse to one group. Children (screenshots,
-- baselines — the only two FKs to test_variations) are re-pointed to the oldest
-- canonical row of each group BEFORE the dupes are deleted, so the cascade
-- deletes nothing.
UPDATE "screenshots" s SET "test_variation_id" = dup.canonical_id
FROM (
	SELECT id AS dup_id, first_value(id) OVER w AS canonical_id
	FROM "test_variations"
	WINDOW w AS (PARTITION BY "project_id","name","browser","viewport","branch_name","os","device" ORDER BY "created_at" ASC, "id" ASC)
) dup
WHERE dup.dup_id <> dup.canonical_id AND s."test_variation_id" = dup.dup_id;
--> statement-breakpoint
UPDATE "baselines" b SET "test_variation_id" = dup.canonical_id
FROM (
	SELECT id AS dup_id, first_value(id) OVER w AS canonical_id
	FROM "test_variations"
	WINDOW w AS (PARTITION BY "project_id","name","browser","viewport","branch_name","os","device" ORDER BY "created_at" ASC, "id" ASC)
) dup
WHERE dup.dup_id <> dup.canonical_id AND b."test_variation_id" = dup.dup_id;
--> statement-breakpoint
DELETE FROM "test_variations" t
USING (
	SELECT id AS dup_id, first_value(id) OVER w AS canonical_id
	FROM "test_variations"
	WINDOW w AS (PARTITION BY "project_id","name","browser","viewport","branch_name","os","device" ORDER BY "created_at" ASC, "id" ASC)
) dup
WHERE dup.dup_id <> dup.canonical_id AND t."id" = dup.dup_id;
--> statement-breakpoint
ALTER TABLE "test_variations" ADD CONSTRAINT "test_variations_identity_unique" UNIQUE NULLS NOT DISTINCT("project_id","name","browser","viewport","branch_name","os","device");
