# GitHub App setup

Provision the GitHub App that the Furan `integrations` service uses: create the
App on GitHub, give the service its credentials, expose the webhook endpoint,
link an installation to a Furan project, and check that each step worked.

Assumes a running self-hosted Furan deployment (see
[docs/runbooks/production-deploy.md](../runbooks/production-deploy.md)). The
[GitHub Actions recipe](./github-actions.md) covers the CI side.

## What works today

Read this first; it decides what you should expect to see on a pull request.

| Part                                                                             | State                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook receiver `POST /webhooks/github` with HMAC-SHA256 signature verification | Works                                                                                                                                                                                                                                         |
| Installation tracking (`installation` and `installation_repositories` events)    | Works: rows in the `installations` table                                                                                                                                                                                                      |
| Linking an installation to a project at `/admin/installations`                   | Works: sets `installations.project_id`                                                                                                                                                                                                        |
| Sticky pull request comment and the `furan/baselines` commit status              | Works for runs that carry the repository, pull request and commit (next section), once the installation is linked to the project. Releases that predate this skip every run with the debug log `run_completed_skipped_missing_github_fields`. |

## What a run needs to reach a pull request

The comment and the status are posted by the `integrations` service when a run
completes. For a run to get that far, four things have to be in place:

1. **The SDK knows the repository, pull request and commit.** It sends them on
   `POST /runs`, and the API stores them on the run. The Kotlin SDK does this
   from 4.3.0. The JavaScript packages (`furan upload`, `@furan/playwright`,
   `@furan/client`, 0.1.x) don't send them yet, so their runs get no comment or
   status.

   | What                | Variable                                                         | On GitHub Actions                                                                                              |
   | ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | Repository          | `FURAN_REPO` (`owner/name`)                                      | Detected from `GITHUB_REPOSITORY`                                                                              |
   | Pull request number | `FURAN_PR_NUMBER`                                                | Detected from the `pull_request` event file (`GITHUB_EVENT_PATH`)                                              |
   | Commit              | `FURAN_COMMIT_SHA` (7 to 64 hex characters, the **head** commit) | Detected: the pull request's head commit on `pull_request` and `pull_request_target` events, else `GITHUB_SHA` |

   An explicit variable wins over the detected value, field by field. Other CI
   systems set the three variables themselves (see the
   [Jenkins](./jenkins.md#report-to-a-github-pull-request) and
   [GitLab CI](./gitlab-ci.md#report-to-a-github-pull-request) pages). A value
   that is malformed is dropped by the SDK, never an error. Use the head commit
   of the pull request: on a `pull_request` event `GITHUB_SHA` is a merge commit,
   and a status posted on it never appears on the pull request.

2. **The App is installed on the repository** and the installation is **linked
   to the Furan project** at `/admin/installations` (step 4 below). The
   service finds the installation through `installations.project_id`; if a
   project has several, the one whose account is the repository owner is used.
3. **`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET`**
   are set on the `integrations` service (step 3 below).
4. **Optional: `DASHBOARD_BASE_URL`** (for example `https://furan.example.com`)
   on the `integrations` service. With it the comment links to the run and the
   commit status links to the build; without it neither has a link.

What gets posted:

- **Comment.** One sticky comment per run (a run is one test), marked with
  `<!-- furan-run-<runId> -->` and edited in place when the run is reported
  again. It is posted only when the run has a pull request number.
- **Commit status `furan/baselines`.** One value per commit, for the whole
  build: the worst status among the build's tests, using the latest run of each
  test name (so a re-run that now passes replaces its earlier run). In order of
  severity: `aborted` is `error`; `failed`, `unresolved` and `empty` are
  `failure`; `running` is `pending`; `new` and `passed` are `success`. So a test
  that passes after another one was left `unresolved` does not turn the commit
  green. Note that `new` counts as `success`: a first capture still waiting for
  its "Save as baseline" leaves the check green, even when `snapshotAndAwait`
  failed the job for it. A build with more than one test gets `(<n> of <total> tests)` in the
  description.
- **Push builds.** A run with a commit but no pull request (a build of `main`,
  say) gets the status and no comment.

Runs made before this was configured, or by an SDK that does not send the three
values, have nothing to report and are skipped (debug log
`run_completed_skipped_missing_github_fields`, naming what was missing).

The comment and the status are refreshed in two situations:

- **A run completes.** The status is recomputed from the build as it is then.
  Two runs that finish at the same moment can post in either order; the next
  refresh posts the then-current value, so the status settles.
- **A reviewer acts in the dashboard.** Approving, rejecting, undoing, or
  forcing a run to passed or failed moves the run's status without a new diff.
  The API announces it (`run.reviewed`) and the service re-posts that run's
  comment and the build-wide status, so approving the last `unresolved` test
  turns `furan/baselines` green without re-running CI. Only the pull request is
  refreshed: Slack and outbound webhooks are not triggered by a review.

An identical commit status is not posted twice. The service remembers the last
one it posted per commit (in memory), because GitHub keeps every status and
allows at most 1000 per commit and context. After a restart it may post the
current one once more. A comment whose text did not change is left as it is.

## 1. Expose the webhook endpoint

GitHub has to reach the `integrations` service over HTTPS. The service listens
on `INTEGRATIONS_PORT` (3400 in both Compose files) and serves the webhook at
`POST /webhooks/github`. **Neither Compose file publishes that port or routes
`/webhooks/github` for you**, so add it. The webhook URL you will give GitHub is
`https://<your-domain>/webhooks/github`; see
[reverse-proxy-tls](../runbooks/reverse-proxy-tls.md) for putting HTTPS in front
of the stack.

### `infra/docker/compose.yml` stack

Publish the port to the host with an override file you create next to
`compose.yml` (here `compose.github-app.yml`), and point your reverse proxy's
`/webhooks/github` at it:

```yaml
# infra/docker/compose.github-app.yml
services:
  integrations:
    ports: ["127.0.0.1:3400:3400"]
```

```bash
docker compose --env-file .env \
  -f infra/docker/compose.yml -f infra/docker/compose.github-app.yml \
  up -d integrations
```

### One-file `furan-compose.yml` (nginx on :8080)

Two edits are needed. Pass the App credentials through to the service (this file
does not list them today):

```yaml
services:
  integrations:
    environment:
      # ...existing entries...
      GITHUB_APP_ID: ${GITHUB_APP_ID:-}
      GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY:-}
      GITHUB_APP_WEBHOOK_SECRET: ${GITHUB_APP_WEBHOOK_SECRET:-}
```

And route the webhook in the inline nginx config, inside the `server { }` block
above `location /`. Keep the doubled `$$`, because Compose would otherwise
interpolate `$http_host` to an empty string:

```nginx
location = /webhooks/github {
  proxy_pass http://integrations:3400;
  proxy_http_version 1.1;
  proxy_set_header Host $$http_host;
  proxy_set_header X-Forwarded-For $$remote_addr;
  proxy_set_header X-Forwarded-Proto $$scheme;
}
```

Then `docker compose -f furan-compose.yml up -d` recreates `integrations` and
`nginx`.

## 2. Create the GitHub App

Open **Settings → Developer settings → GitHub Apps → New GitHub App** (for an
organization: **Organization settings → Developer settings → GitHub Apps**).

| Field                     | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name           | Unique across GitHub, e.g. `furan-baselines-<your-org>`. Its slug is the install URL: `https://github.com/apps/<slug>`      |
| Homepage URL              | Your Furan dashboard URL                                                                                                    |
| Callback URL, Setup URL   | Leave empty; "Request user authorization (OAuth) during installation" stays unchecked. The service implements no OAuth flow |
| Webhook: Active           | Checked                                                                                                                     |
| Webhook URL               | `https://<your-domain>/webhooks/github`                                                                                     |
| Webhook secret            | A random string you generate, e.g. `openssl rand -hex 32`. Keep it; it becomes `GITHUB_APP_WEBHOOK_SECRET`                  |
| SSL verification          | Enabled                                                                                                                     |
| Where can it be installed | **Only on this account** for an internal deployment                                                                         |

### Permissions

**Repository permissions:**

| Permission      | Access         | Used for                                                                                                        |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Commit statuses | Read and write | The `furan/baselines` status (`repos.createCommitStatus`, the older Statuses API, not Checks)                   |
| Pull requests   | Read and write | The sticky comment (the issue-comment endpoints accept Pull requests or Issues write) and `pull_request` events |
| Metadata        | Read-only      | Mandatory; GitHub adds it for you                                                                               |

No account or organization permissions are needed.

### Events

Under **Subscribe to events**, tick **Pull request** (optional: the handlers for
`pull_request.opened` and `pull_request.closed` only write a log line today).
`installation` and `installation_repositories` are delivered to every GitHub App
automatically; they are not in the list and you do not need to subscribe.

### Credentials

After **Create GitHub App**:

1. Copy the **App ID** from the top of the App's settings page. It becomes `GITHUB_APP_ID`.
2. Under **Private keys**, choose **Generate a private key**. GitHub downloads a
   `.pem` file once. It becomes `GITHUB_APP_PRIVATE_KEY`.

## 3. Give the service its credentials

`apps/integrations/src/env.ts` defines three optional variables that work as an
**all-or-nothing group**:

| Variable                    | Value                               |
| --------------------------- | ----------------------------------- |
| `GITHUB_APP_ID`             | The App ID (digits)                 |
| `GITHUB_APP_PRIVATE_KEY`    | The full PEM text, `BEGIN` to `END` |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret from step 2      |

Leave all three unset (or empty) and the service starts with the GitHub receiver
disabled: `POST /webhooks/github` answers `503 github_app_not_configured`. Set
only some of them and the service **exits at startup** with
`Invalid environment: {}`; the log line has `"msg":"startup_failed"`, and the
real reason (they must be set together) is not part of the printed message.

Both Compose files read these from the `.env` that Compose uses: the repo-root
`.env` you pass with `--env-file` (the README flow), or the `.env` next to the
Compose file if you run `furan-compose.yml` directly. `infra/docker/compose.yml`
already passes the three variables through to the service:

```yaml
GITHUB_APP_ID: ${GITHUB_APP_ID:-}
GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY:-}
GITHUB_APP_WEBHOOK_SECRET: ${GITHUB_APP_WEBHOOK_SECRET:-}
```

Optionally also set `DASHBOARD_BASE_URL` (your dashboard's public origin, for
example `https://furan.example.com`) so the comment and the commit status link to
the run and build pages. Both Compose files pass it through; leave it unset for
no links.

### Putting the multi-line private key in `.env`

Either form below resolves to the complete PEM (checked with
`docker compose config` on Compose v5.4). The single-line form is safer if the
file is also loaded by a shell.

Single line, newlines written as `\n` inside double quotes:

```bash
printf 'GITHUB_APP_PRIVATE_KEY="%s"\n' \
  "$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' furan-app.private-key.pem)" >> .env
```

Or paste the key literally between double quotes:

```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIE...
-----END RSA PRIVATE KEY-----"
```

Add the other two lines, then restart the service:

```bash
echo "GITHUB_APP_ID=123456" >> .env
echo "GITHUB_APP_WEBHOOK_SECRET=<the secret from step 2>" >> .env
docker compose --env-file .env -f infra/docker/compose.yml up -d integrations
```

The `.env` now holds a private key: keep it out of version control and
readable only by the deploy user. There is no live reload for any of the three
values. To rotate the webhook secret or the key, change `.env`, update the App
settings on GitHub, and restart `integrations`.

## 4. Install the App and link it to a project

1. On the App's settings page choose **Install App**, pick the account, and
   select the repositories that run your Furan tests.
2. GitHub sends an `installation` event; the service stores the installation
   (installation ID, account login, repository IDs) in the `installations` table.
3. In the Furan dashboard open `/admin/installations` (admin only). Rows are
   sorted by creation time, oldest first, so the newest install is at the
   bottom. Pick the Furan project for the installation from the row's select;
   the change saves automatically.

Repositories added to or removed from the installation later update the stored
repository IDs through `installation_repositories` events. Uninstalling the App
deletes the row.

## 5. Check it works

Work down the list; each check isolates one layer.

1. **Credentials loaded.** The service logs `github_app_configured` at startup:

   ```bash
   docker compose --env-file .env -f infra/docker/compose.yml logs integrations | grep github_app
   ```

   `github_app_not_configured` (a warning) means the variables are unset or empty.

2. **Webhook reachable and configured.** Without any secret:

   ```bash
   curl -i -X POST https://<your-domain>/webhooks/github
   ```

   | Response                                    | Meaning                                                                  |
   | ------------------------------------------- | ------------------------------------------------------------------------ |
   | `400 {"error":"missing_github_headers"}`    | Routed to the service and the App is configured. This is the good answer |
   | `503 {"error":"github_app_not_configured"}` | Routed, but the credentials are not set (step 3)                         |
   | `404`, `502`, or the dashboard's HTML       | The route from step 1 is missing or points at the wrong place            |

3. **Signature accepted.** On the App's settings page open **Advanced → Recent
   Deliveries**. Every delivery the service accepts shows `204`; if GitHub sent a
   `ping` when you created the App, that is the first one to check (otherwise the
   `installation` delivery in the next check is your first real test).
   `400 invalid_signature` means the secret on GitHub differs from
   `GITHUB_APP_WEBHOOK_SECRET`. After fixing it, open the delivery and press
   **Redeliver**.

4. **Installation recorded.** After installing, the `installation` delivery is
   `204`, the logs show `installation_created` with the installation ID, account
   login and repository count, and the row appears at `/admin/installations`.
   Or query it:

   ```bash
   docker compose --env-file .env -f infra/docker/compose.yml exec postgres \
     psql -U furan -d furan \
     -c "SELECT installation_id, account_login, project_id FROM installations;"
   ```

   (`furan` is the default `POSTGRES_USER` and `POSTGRES_DB`; use yours if you changed them.)

   If you installed before the webhook worked, there is no row: redeliver the
   `installation` event from **Recent Deliveries**.

5. **Installation token mintable.** A wrong private key or App ID does not show
   up until a run completes: the service then logs
   `run_completed_installation_octokit_failed` with the installation ID. This
   needs a run that got past the checks in
   [What a run needs to reach a pull request](#what-a-run-needs-to-reach-a-pull-request).

6. **Pull request comment and status.** Set `LOG_LEVEL=debug` on `integrations`
   and complete a run from CI on a pull request. You should see
   `run_completed_github_updated`, a comment containing `<!-- furan-run-<runId> -->`
   on the pull request, and a `furan/baselines` status on its head commit. If you
   see `run_completed_skipped_missing_github_fields` instead, its `missing` list
   names the gap:

   | `missing` contains               | Meaning                                                                                                                                                                                                    |
   | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `repoOwner`, `repoName` or `sha` | The SDK did not send the repository or commit: set `FURAN_REPO` and `FURAN_COMMIT_SHA`, or run on GitHub Actions, and use a Kotlin SDK that sends them (4.3.0 or later; the JavaScript packages don't yet) |
   | `installationId`                 | No installation is linked to the run's project: link it at `/admin/installations` (step 4)                                                                                                                 |

   A run without a pull request number is not skipped: it gets the status and no
   comment. A log line `run_completed_github_update_failed` with a GitHub `404`
   means the repository is outside the installation's access: add it to the
   App's repository selection.

## Troubleshooting

| Symptom                                             | Likely cause                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations` exits with `Invalid environment: {}` | Only some of `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` are set; set all three or none                                                            |
| `503 github_app_not_configured` from the webhook    | The three variables are unset or empty in the container; in `furan-compose.yml` they must also be listed under the service (step 1)                                           |
| `400 invalid_signature`                             | Webhook secret mismatch, or the secret in `.env` was altered by quoting (generate it with `openssl rand -hex 32` to avoid special characters)                                 |
| `400 missing_github_headers`                        | The request did not come from GitHub (or a proxy dropped the `X-GitHub-*` headers)                                                                                            |
| Deliveries time out or show a connection error      | The webhook URL is not reachable from GitHub: DNS, firewall, TLS certificate, or the route from step 1                                                                        |
| No row at `/admin/installations`                    | The `installation` delivery failed or was sent before the webhook worked; redeliver it                                                                                        |
| JWT or key errors when a run completes              | `GITHUB_APP_PRIVATE_KEY` lost its newlines (use one of the two forms in step 3) or belongs to a different App than `GITHUB_APP_ID`                                            |
| No comment or status on the pull request            | Check 6 in step 5: the `missing` list in `run_completed_skipped_missing_github_fields`, then that the App is installed on that repository                                     |
| Status is on the wrong commit or never shows        | `FURAN_COMMIT_SHA` is a merge commit, not the pull request's head commit (detected correctly on GitHub Actions; set it by hand elsewhere)                                     |
| Status is `failure` although this test passed       | Another test of the same build is `unresolved`, `failed`, `empty` or `aborted` (the status is the worst of the build); it turns green when the last one is approved or passes |
| Comment or status has no link                       | `DASHBOARD_BASE_URL` is not set on the `integrations` service                                                                                                                 |

## See also

- [GitHub Actions recipe](./github-actions.md): the CI workflow that produces the runs
- [Production deploy runbook](../runbooks/production-deploy.md): running the full stack, including the `integrations` service
- [Reverse proxy and TLS](../runbooks/reverse-proxy-tls.md): exposing the stack on a domain over HTTPS
- `apps/integrations/src/env.ts`, `apps/integrations/src/github/`: the service's configuration and handlers
