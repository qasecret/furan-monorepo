---
title: First-install problems
sidebar_label: First-install problems
---

# First-install problems

## One-file install (`furan-compose.yml`)

**The SDK or `curl` gets "connection refused" on port `3000`.** The one-file
install publishes only port `8080`: nginx serves the dashboard at `/` and the
API at `/api`. Set `FURAN_API_URL=http://<host>:8080/api`.

**Port `8080` is already taken.** Set `FURAN_HTTP_PORT` to a free port before
`up`, and set `FURAN_DASHBOARD_ORIGIN=http://<host>:<port>` to match.

**Every page and API call answers `502 Bad Gateway` after an upgrade.** nginx
still points at the containers the upgrade replaced. `docker compose -f
furan-compose.yml restart nginx` fixes it. A `furan-compose.yml` downloaded
after v1.1.35 restarts nginx by itself when the app containers change.

**Sign-in fails with the default password.** The admin is created once, on
the first boot, from `FURAN_BOOTSTRAP_ADMIN_PASSWORD` (default
`FuranAdmin123!`). Exporting a different value later doesn't change it.

## Production install (`compose.yml`)

**The dashboard loads, but its data never appears (or an action says "Could not reach the API").** The browser is loading the dashboard but the API host isn't reachable from your browser. Check that `NEXT_PUBLIC_API_URL` in `.env` matches where you're actually serving the API — for the default Compose install that's `http://localhost:3000`.

**`docker compose ... up -d` fails with port conflicts.** The default Compose stack publishes only ports `3000` (api) and `3001` (dashboard); Postgres, Redis and MinIO stay on the Compose network. If you already have something on those ports, either stop it or edit the port mappings in `infra/docker/compose.yml`.

**The api keeps restarting with `startup_failed` … `TypeError: Invalid URL`.** `POSTGRES_PASSWORD` contains a character that breaks the database URL the api is given, typically a `/` from a base64 value. Use a hex password (`openssl rand -hex 24`). Postgres keeps the password it was first started with, so on a fresh install remove the volume (`docker compose … down -v`) before `up` again; on an install with data, change the password inside Postgres first (`ALTER USER furan PASSWORD '…'`).

**API exits at boot with `FURAN_BOOTSTRAP_ADMIN_EMAIL must be replaced from .env.example placeholder` (or the same for `_PASSWORD`).** You forgot to edit the two new keys at the top of `.env`. Either replace `change-me` / `change-me-run: openssl rand -hex 24` with real values (the API will then seed a first admin) — or remove both lines entirely and seed via the `seed-admin` CLI (see [Adding more admins or resetting a password](../install/compose.md#adding-more-admins-or-resetting-a-password)).

**API exits at boot with `JWT_SECRET must be ≥32 chars`.** Generate a new one with `openssl rand -hex 32` and restart the api container.

**Screenshots upload but the diff viewer is empty.** The diff worker may be down or stuck. Check `docker compose ... ps` for `diff-worker` health, and `docker compose ... logs diff-worker` for the last error. The [`docs/runbooks/api-down.md`](../runbooks/api-down.md) triage tree covers worker-stuck symptoms as well.

**SDK upload fails with `401 unauthorized`.** Most likely cause: the API token wasn't copied correctly, or it's been deleted. Create a new one: admins under **Admin → API Tokens**, editors at `/account/tokens`. `401 token_expired` means the token's lifetime is over: create a replacement.

**SDK call fails with `403`.** The `code` says why: `token_project_mismatch` (the token is bound to another project — check `FURAN_PROJECT_ID`), `not_a_project_member` (an unbound token works only on projects its owner is a member of), `insufficient_scope` (a read-only token tried to upload), or `session_required` (tokens can't call that endpoint; sign in instead).

**`furan upload` exits 1, 2 or 3.** 1: a screenshot needs review (open the link in the summary). 2: bad input or configuration, so nothing was sent (the message names the file or variable). 3: no verdict: the api was unreachable or refused the request, or the wait timed out (`--timeout`). `furan upload --dry-run` shows the resolved settings without sending anything; `response was not JSON` means `FURAN_API_URL` points at the dashboard instead of the api (with the one-file install the api is under `/api`).
