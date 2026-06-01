# Runbook — alpha-install dry-run measurement

> **Status: TBD — pending real dry-run on a fresh Hetzner-AX52-class host.**
>
> Target per the furan-design roadmap §9 ("Success metrics") dogfood
> commitment: **<30 minutes** first-time install (cold host, cold caches);
> **<10 minutes** re-install (warm pnpm + docker layer cache).
>
> This file is a template. The maintainer (or first external alpha
> installer) fills in the table on a real measurement run, lands fixes
> for any friction caught along the way, and converts the file to a
> permanent record. Until then it is a placeholder for the v1.0 GA
> acceptance gate.

## Host details

| Field              | Value                                  |
| ------------------ | -------------------------------------- |
| Date               | _TBD_                                  |
| Operator           | _TBD_                                  |
| Host class         | _TBD_ (target: Hetzner AX52 or peer)   |
| CPU / cores        | _TBD_                                  |
| RAM                | _TBD_                                  |
| Disk free at start | _TBD_                                  |
| OS + kernel        | _TBD_                                  |
| Docker version     | _TBD_                                  |
| Node version       | _TBD_ (must be 22 LTS)                 |
| pnpm version       | _TBD_ (must be 9.15+)                  |
| Network egress     | _TBD_ (data-centre Gbit vs home cable) |

## Step-by-step timing table

Times are wall-clock from "command entered" to "next command ready to
enter". Use the [install quickstart](../install/quickstart.md) as the
canonical step list.

| Step                                             | Duration | Notes                                                                                              |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| Docker install (if needed)                       |          |                                                                                                    |
| Node 22 + pnpm 9 install (if needed)             |          | `nvm install 22` + `corepack enable`                                                               |
| Clone monorepo                                   |          |                                                                                                    |
| `pnpm install`                                   |          | cold cache vs warm cache                                                                           |
| `.env` edit (copy + secrets)                     |          | `openssl rand -hex 32` for `JWT_SECRET`                                                            |
| `docker compose ... up -d` (data plane)          |          | image pulls (cold) vs cache hit (warm)                                                             |
| Wait for healthchecks                            |          | should be ~15s                                                                                     |
| `pnpm --filter @furan/db db:migrate`             |          | dev path only; Docker-only install runs `compose.yml`'s `migrate` service automatically on `up -d` |
| Seed first admin (`cli:seed-admin`)              |          |                                                                                                    |
| Start `pnpm --filter @furan/api dev`             |          | time-to-`listening` log line                                                                       |
| Start `pnpm --filter @furan/dashboard dev`       |          | time-to-`ready` log line + first compile                                                           |
| Start capture-worker + diff-worker               |          |                                                                                                    |
| Browser login at `/login`                        |          |                                                                                                    |
| Project bootstrap (curl `POST /projects`)        |          |                                                                                                    |
| Editor user create + project membership add      |          |                                                                                                    |
| PAT mint at `/account/tokens`                    |          |                                                                                                    |
| First capture enqueue (script in quickstart §11) |          |                                                                                                    |
| First diff row visible at `/projects/.../runs`   |          |                                                                                                    |
| **Total (first-time)**                           |          | target <30 min                                                                                     |
| **Total (re-install, warm caches)**              |          | target <10 min                                                                                     |

## Friction points

> Bulleted log of every step that took longer than expected, surprised
> the operator, required a doc lookup, or threw an unexpected error.
> Each entry should be specific enough that the fix-up commit message
> can quote it.

- _TBD_

## Fixes applied during measurement

> If the dry-run surfaces a real bug or doc gap, patch it on
> `phase-3/auth+dogfood` (or a follow-up branch) and record commit SHAs
> here. Re-time the affected step after the fix and update the table
> above.

| Friction | Commit | Re-timed step | New duration |
| -------- | ------ | ------------- | ------------ |
| _TBD_    | _TBD_  | _TBD_         | _TBD_        |

## Final timing summary

- First-time install: **_TBD_** (target: <30 min)
- Re-install (warm caches): **_TBD_** (target: <10 min)
- Diff visible from cold host: **_TBD_** (target: <30 min)
- Pass / fail vs targets: **_TBD_**

## Sign-off

- Operator: _TBD_
- Date: _TBD_
- Branch + commit recorded at measurement time: _TBD_
- Linked feedback file (if external installer):
  `docs/feedback/alpha-1-<handle>.md` — _TBD_
