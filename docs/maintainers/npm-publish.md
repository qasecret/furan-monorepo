# npm publish runbook (JS packages)

This runbook covers publishing the three JavaScript packages to npm:

| Package             | Folder                | What it is                                                     |
| ------------------- | --------------------- | -------------------------------------------------------------- |
| `@furan/client`     | `packages/client`     | The REST client and the build → test → check → verdict helpers |
| `@furan/cli`        | `packages/cli`        | `furan upload`, plus the GitHub Action (`action.yml`)          |
| `@furan/playwright` | `packages/playwright` | The Playwright Test fixture                                    |

They always share one version (release-please's `linked-versions` plugin) and
are published by [`.github/workflows/publish-npm.yml`](../../.github/workflows/publish-npm.yml)
with **npm Trusted Publishing**: GitHub's OIDC token proves the workflow to
npm, so no npm token is stored in the repository and every version carries a
provenance attestation. ADR-080 records the decision.

## One-time maintainer setup

### 1. Create the `@furan` npm organization

Sign in to [npmjs.com](https://www.npmjs.com) with two-factor authentication
on and create the free organization **`furan`** (Add organization → Unlimited
public packages). Owning the scope also keeps the private `@furan/*` workspace
package names (`@furan/db`, `@furan/shared-types`, …) from being registered by
someone else, which protects the monorepo from dependency confusion.

### 2. Publish the first version

npm lets you attach a trusted publisher only to a package that exists, so the
very first version of each package is published with a token: either from
GitHub Actions with a short-lived token (recommended, and the version gets a
provenance attestation), or by hand from a maintainer's machine.

#### From GitHub Actions with a bootstrap token

1. On npmjs.com, Access Tokens → Generate New Token → **Granular Access
   Token**: expiration 7 days, **Bypass two-factor authentication** on,
   Packages and scopes **Read and write** for the `@furan` scope (or all
   packages), Organizations **No access**.
2. Store it as the repository secret `NPM_TOKEN` (it is read from your
   terminal, never echoed):

   ```bash
   gh secret set NPM_TOKEN --repo qasecret/furan-monorepo
   ```

3. Run the workflow from `main`, not from the release tag: a run started on
   the tag uses the tag's copy of the workflow, which predates the token
   support. `main` must still carry the released versions (no later JS
   release merged), which `node -p "require('./packages/client/package.json').version"`
   confirms.

   ```bash
   gh workflow run publish-npm.yml --repo qasecret/furan-monorepo --ref main
   ```

4. After it has published all three, add the trusted publishers (step 3),
   then delete the secret and revoke the token on npmjs.com:

   ```bash
   gh secret delete NPM_TOKEN --repo qasecret/furan-monorepo
   ```

#### By hand

After the first release PR (step 2 of the release flow below) is merged and
tagged, check out that tag and run, in this order:

```bash
git checkout client/v0.1.0
pnpm install --frozen-lockfile
pnpm turbo run build typecheck lint test --filter=@furan/client --filter=@furan/cli --filter=@furan/playwright
npm login            # with 2FA
for pkg in client playwright cli; do
  tarball="$(cd "packages/$pkg" && pnpm pack --pack-destination /tmp/furan-pkgs | tail -1)"
  npm publish "$tarball" --access public --provenance=false
done
```

(`pnpm pack` rewrites the `workspace:^` dependency on `@furan/client` to
`^<version>`; `npm publish <tarball>` then uploads exactly what was packed.
`--provenance=false` is needed here because the packages set
`publishConfig.provenance`, which npm can only honour inside CI. A
hand-published first version has no provenance attestation; every later one
does.)

The release PR's merge also starts `publish-npm.yml` for that first version.
Without `NPM_TOKEN` that run **fails** at the publish step with `ENEEDAUTH`
(the packages don't exist on npm yet, so no trusted publisher can be
attached); this is expected. Publish with a token as above, add the trusted
publishers (step 3), then re-run the workflow if you want it green: it skips
the versions that are already on npm.

### 3. Add the trusted publisher to each package

On npmjs.com, for each of `@furan/client`, `@furan/cli` and
`@furan/playwright`: package → Settings → Trusted Publisher → GitHub Actions:

- Organization or user: `qasecret`
- Repository: `furan-monorepo`
- Workflow filename: `publish-npm.yml`
- Environment: leave empty

Then, under Settings → Publishing access, choose "Require two-factor
authentication and disallow tokens", so only the workflow (or a maintainer with
2FA) can publish.

## Release flow

### 1. Use Conventional Commits on PRs to `main`

A `feat(client):`, `feat(cli):`, `fix(playwright):` (and so on) commit that
touches one of the three package folders makes release-please propose a
release of all three: they share one version. `feat` bumps the minor version
and `fix` the patch while the packages are below 1.0 (`bump-minor-pre-major`
keeps a breaking change from jumping to 1.0.0).

### 2. release-please opens a Release PR

The PR bumps the three `package.json` versions and their `CHANGELOG.md`s
together. When the Kotlin SDK has unreleased changes at the same time, the
same PR also carries its release.

### 3. Merge the Release PR

release-please tags `client/v<x>`, `cli/v<x>` and `playwright/v<x>` on the
merge commit. The `client/v<x>` tag starts `publish-npm.yml`, which:

1. builds, typechecks, lints and tests the three packages; a red package is
   never published;
2. packs and publishes `@furan/client`, then `@furan/playwright`, then
   `@furan/cli`, skipping any version that is already on npm.

The `cli/v<x>` tag is also what GitHub Action users pin
(`uses: qasecret/furan-monorepo/packages/cli@cli/v<x>`): the action runs the
`@furan/cli` version in the `package.json` beside `action.yml`, so the action
and the CLI never drift.

### Re-running a release

If a run fails part-way (npm outage, a transient error), re-run it from the
Actions tab, or:

```bash
gh workflow run publish-npm.yml --ref client/v<x>
```

Versions already on npm are skipped, so the re-run publishes only what is
missing. A version can never be re-published with different contents; fix
forward with a new patch release.

## Dry run (local, no publishing)

```bash
pnpm turbo run build --filter=@furan/client --filter=@furan/cli --filter=@furan/playwright
for pkg in client playwright cli; do
  (cd "packages/$pkg" && pnpm pack --pack-destination /tmp/furan-pkgs)
done
tar -tzf /tmp/furan-pkgs/furan-cli-*.tgz   # expect dist/, action.yml, action/run.sh, README.md
```

## Notes / caveats

- `pnpm pack` in pnpm 9 does not accept `--filter`; it is run inside each
  package folder.
- The packages are ESM-only and need Node 20.19 or later (CommonJS projects
  can `require()` them from that version on).
- Trusted Publishing needs npm 11.5.1 or later in the workflow; the workflow
  installs it.
