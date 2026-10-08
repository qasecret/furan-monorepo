-- ADR-058 Release N+1, Migration A (additive; RLS still OFF, no behavior change).
-- Creates the SECURITY DEFINER membership helpers + the non-owner `furan_app`
-- runtime role the API connects as. No policies here — enabling RLS is a
-- separate migration (B). Reversible: drop the policies (none yet), then the
-- role + functions.

--> statement-breakpoint
-- Identity helpers. `nullif(...,'')::uuid` yields NULL for an unset/empty GUC
-- (withUserScope's no-auth default) instead of raising on `''::uuid`, so an
-- un-scoped connection fails closed once policies land.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.user_role', true) IN ('admin', 'owner') $$;
--> statement-breakpoint
-- Owned by the migration runner (table owner) → SECURITY DEFINER lets it read
-- project_members bypassing that table's (future) RLS policy, which is what
-- prevents policy recursion. STABLE so the planner caches it per statement.
CREATE OR REPLACE FUNCTION app_current_user_projects() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT pm.project_id FROM project_members pm
    WHERE pm.user_id = app_current_user_id()
  $$;
--> statement-breakpoint
-- Non-owner runtime role the API connects as (subject to RLS once policies
-- land). Created idempotently and WITHOUT a login password — the operator sets
-- `ALTER ROLE furan_app LOGIN PASSWORD '…'` + the DATABASE_URL_APP connection
-- string out-of-band (see docs/runbooks), so no secret is baked into a
-- migration. Workers, CLIs, and migrations keep using the owner role (which
-- bypasses RLS). NOLOGIN until the operator grants LOGIN.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'furan_app') THEN
    CREATE ROLE furan_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO furan_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO furan_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO furan_app;
--> statement-breakpoint
-- Future tables/sequences created by the owner are auto-granted to furan_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO furan_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO furan_app;
--> statement-breakpoint
-- Lock the SECURITY DEFINER function down + let furan_app call the helpers.
REVOKE ALL ON FUNCTION app_current_user_projects() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id() TO furan_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_admin() TO furan_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_projects() TO furan_app;
