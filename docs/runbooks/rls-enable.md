# Runbook — enable Postgres row-level security (ADR-058)

Furan ships a **defense-in-depth** row-level-security backstop under the
project-scoping convention. With RLS active, a forgotten `project_id` filter in
an API query returns **zero cross-tenant rows** instead of leaking. It is
**off by default** and opt-in per install.

## What's already in place (after migrations 0032 + 0033)

- SECURITY DEFINER helper functions (`app_is_admin`, `app_current_user_projects`).
- A non-owner role **`furan_app`**, created `NOLOGIN`, with DML grants.
- `ENABLE ROW LEVEL SECURITY` + isolation policies on every project-scoped table.

None of this changes behavior yet: the **owner** role (which the API, workers,
CLIs, and migrations all use by default) **bypasses RLS**. RLS only takes effect
for a connection made as `furan_app`.

## Enabling it

1. **Give `furan_app` a login + password** (run as the DB owner/superuser):

   ```sql
   ALTER ROLE furan_app WITH LOGIN PASSWORD '<a-strong-password>';
   ```

2. **Point ONLY the API at `furan_app`** via `DATABASE_URL_APP`:

   ```
   DATABASE_URL_APP=postgresql://furan_app:<password>@<host>:5432/<db>
   ```

   Leave `DATABASE_URL` (the owner role) as-is — **workers, CLIs, and migrations
   must keep using it** (they do legitimate cross-project work and rely on the
   owner bypass). Only `apps/api` reads `DATABASE_URL_APP`.

3. **Restart the API.** On boot it logs which role it connected as:
   - `db_connected_as_rls_subject_role` → RLS backstop is **live**.
   - `db_connected_as_owner_rls_backstop_inactive` → still on the owner (unset or
     wrong `DATABASE_URL_APP`).

4. **Canary before wide rollout.** Smoke-test the core flows on the `furan_app`
   connection — log in, list builds, open a run, upload a screenshot via the SDK.
   Correctly-scoped code is unchanged; if a path was missed it fails **closed**
   (empty results / 404), never a leak.

## Rolling back

RLS is reversible without data change:

- **Fast:** unset `DATABASE_URL_APP` and restart the API — it reconnects as the
  owner (bypass). Policies remain but are inert.
- **Full:** a down-migration `DISABLE ROW LEVEL SECURITY` + `DROP POLICY` per
  table (migration 0033), then drop the role + functions (0032). Can be done
  table-by-table if a single policy misbehaves.

## Constraints

- **No `FORCE ROW LEVEL SECURITY`** — the owner intentionally bypasses so
  migrations/workers/CLIs are unaffected.
- **pgBouncer, if introduced, MUST run in transaction pooling mode.** The
  per-request identity is set via `SET LOCAL` inside a transaction; session or
  statement pooling would break the guarantee (`arch-backend.md §4.11`). Furan
  talks directly to Postgres today, so this is unconstrained until a pooler is
  added.
- Isolation is keyed on **project** (ADR-052), not org.

## Verifying

The `packages/db` `rls.test.ts` integration suite connects as `furan_app` and
proves: read isolation, cross-tenant denial, fail-closed with no identity, admin
bypass, `WITH CHECK` on writes, and no GUC leak across the pool.
