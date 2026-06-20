-- 0026: Backfill users.default_project_id from each user's earliest membership.
--
-- U8 (single-project tenancy) lands every user on a default project. The column
-- was added nullable in 0025; this data migration fills it for existing users
-- who have at least one project_members row but no default yet, choosing the
-- earliest-joined project (oldest created_at) as the landing project.
--
-- Data-only: no schema change, so drizzle-kit generate does not emit this — it
-- is hand-authored. Idempotent: the WHERE guard skips users that already have a
-- default, and users with no membership are left NULL (admin assigns later).

UPDATE users u
SET default_project_id = (
  SELECT pm.project_id FROM project_members pm
  WHERE pm.user_id = u.id
  ORDER BY pm.created_at ASC
  LIMIT 1
)
WHERE u.default_project_id IS NULL;
