# Migration conventions — expand/contract, no destructive rewrites

This runbook is the **authoring** convention for schema migrations. Its sibling,
[`migration-deploy-order.md`](./migration-deploy-order.md), covers how to
_deploy_ a narrowing migration once written; this one covers how to _write_
migrations so they never force downtime or data loss in the first place.

**Rule of thumb: a migration must be safe to run while the _previous_ release is
still serving traffic.** Old code and the new schema coexist for the duration of
a rollout, so the schema can only ever be a superset of what both the old and
new code need.

## The anti-pattern we're moving away from

Migration `0017_batch_test_checkpoint_model.sql` did:

```sql
TRUNCATE test_runs, screenshots, diff_regions CASCADE;
-- ⚠️ OPERATOR NOTICE — all approved baselines are wiped.
```

A destructive cutover like this means:

- **Data loss** — every historical run + approved baseline is gone. On an
  install with months of history this is unrecoverable without a restore.
- **No zero-downtime path** — you cannot run this while the old image serves
  traffic; you must take the stack down.
- **No rollback** — there is no `DOWN`; recovery is a full `pg_dump` restore,
  losing everything written since the snapshot.

Do not add another migration of this shape. If a model change seems to require
wiping a table, it almost always decomposes into the expand/contract steps
below.

## Expand / contract (the pattern to use)

Split any structural change into additive-then-subtractive phases, each shipping
in its **own** release:

1. **Expand (release _N_)** — add the new shape _alongside_ the old one. New
   columns are **nullable** or carry a `DEFAULT`; new tables are created empty.
   Never `NOT NULL` without a default in this step (it rejects the old code's
   inserts). Old code ignores the new shape; new code can read/write both.
2. **Backfill (release _N_, online)** — populate the new columns/tables from the
   existing data in batches (idempotent `UPDATE ... WHERE new IS NULL`), so it
   can run while traffic continues and be re-run safely.
3. **Contract (release _N+2_, after the backfill is verified and no running
   image reads the old shape)** — drop the old column/table, and only now add a
   `NOT NULL` / tighten a constraint if needed.

Ship expand and contract in **different releases** (hence "N+2"): between them,
both the old and new images must be able to run against the intermediate schema.

### Concrete shapes

| You want to…                    | Do instead                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Add a required column           | add nullable/`DEFAULT` → backfill → set `NOT NULL` in a later release                |
| Rename a column                 | add new col → backfill + dual-write → switch reads → drop old col later              |
| Change a column's type          | add new-typed col → backfill → swap reads/writes → drop old col later                |
| Narrow an enum / `CHECK`        | see [`migration-deploy-order.md`](./migration-deploy-order.md) (stop-writers window) |
| "Reset" a table for a new model | model it as expand/contract; never `TRUNCATE` production data                        |

## Checklist for every new migration

- [ ] Runs cleanly against the **current** production schema with the
      **previous** app image still live (no `NOT NULL`-without-default, no drop
      of a column the live image still selects).
- [ ] Forward-only, but structured so the previous release is a valid rollback
      target (restore the pre-deploy snapshot loses only in-window writes — see
      `migration-deploy-order.md §4`).
- [ ] No `TRUNCATE` / `DELETE` of user data. Data moves happen via backfill, not
      destruction.
- [ ] Large backfills are batched + idempotent, not a single table-locking
      `UPDATE`.
- [ ] If it narrows a constraint, it's paired with the stop-writers deploy
      procedure and called out in the PR description.

## Why forward-only is still fine

Drizzle migrations are applied by hash and have no generated `DOWN`. That's
acceptable _because_ expand/contract keeps each step non-destructive: the
recovery path for a bad migration is "deploy the previous image" (the schema is
a superset both understand) rather than "reverse the SQL." Destructive
migrations break that guarantee — which is exactly why we don't write them.
