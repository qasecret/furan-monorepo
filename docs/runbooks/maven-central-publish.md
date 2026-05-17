# Maven Central publish runbook (sdk-kotlin)

This runbook covers everything needed to publish `io.furan:sdk-core` and
`io.furan:sdk-selenium` to Maven Central via the Sonatype Central Portal.

## One-time maintainer setup

### 1. Register the `io.furan` namespace

Sign in to the [Central Portal](https://central.sonatype.com/) and register
`io.furan` as a namespace. Two verification paths are accepted:

- **GitHub OIDC verification (recommended)** — the Portal hands you a temporary
  repo name (e.g. `OSSRH-1234`); create that repo under `qasecret` to prove
  ownership of the GitHub org tied to `io.furan`.
- **DNS TXT record** — only viable once we own `furan.io`. Add the TXT record
  the Portal gives you to `furan.io` and verify.

Use the GitHub OIDC path until the domain is registered.

### 2. Generate a PGP signing key

```bash
gpg --gen-key
# Use real name "Furan Maintainers" + email "maintainers@furan.dev"
# Use a strong passphrase — it goes into SIGNING_PASSWORD below

# Find the key id
gpg --list-secret-keys --keyid-format=long

# Publish the public key so Central can verify signatures
gpg --keyserver keys.openpgp.org --send-keys <KEY_ID>
```

### 3. Export the private key for CI

```bash
gpg --armor --export-secret-keys <KEY_ID> > private.asc
```

Keep `private.asc` out of git. Delete it from disk once it is loaded into the
GitHub Actions secret in step 4.

### 4. Add GitHub Actions secrets (org-level recommended)

```bash
gh secret set MAVEN_CENTRAL_USERNAME --org qasecret --visibility all
gh secret set MAVEN_CENTRAL_PASSWORD --org qasecret --visibility all
gh secret set SIGNING_KEY            --org qasecret --visibility all < private.asc
gh secret set SIGNING_PASSWORD       --org qasecret --visibility all
```

- `MAVEN_CENTRAL_USERNAME` — Central Portal user-token **name**
  (Portal → Account → Generate User Token)
- `MAVEN_CENTRAL_PASSWORD` — Central Portal user-token **password**
- `SIGNING_KEY` — the full armored PGP private key (multi-line; pipe the file in)
- `SIGNING_PASSWORD` — passphrase chosen in step 2

After setting `SIGNING_KEY`, delete `private.asc`:

```bash
shred -u private.asc 2>/dev/null || rm -P private.asc
```

### 5. Verify namespace ownership before the first release

In the Central Portal UI, confirm `io.furan` is listed as a verified namespace
on the maintainer account. Do this **before** pushing the first `sdk/v*` tag —
the upload will be rejected otherwise.

## Release flow

1. Bump `version=` in `packages/sdk-kotlin/gradle.properties`.
2. Commit and merge to `main`.
3. Push a release tag:
   ```bash
   git tag sdk/v0.5.0
   git push origin sdk/v0.5.0
   ```
4. Tag push triggers `.github/workflows/release.yml`, which runs
   `./gradlew :core:publish :selenium:publish` against the Central Portal upload API.
5. Watch the workflow run. On success, the artifacts land in the Central Portal
   **staging** area.
6. Open the Central Portal UI → Deployments. Verify the staged artifacts look
   right (groupId, artifactId, version, sources + javadoc jars, `.asc` signatures
   present). **Manually promote / release from the Portal UI** — auto-release is
   intentionally off until we have several clean releases under our belt.
7. After promotion, expect Maven Central search index propagation to take
   ~15 min – 4 h.

## Dry-run (local, no secrets)

Verify the publish wiring without ever touching Maven Central:

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd packages/sdk-kotlin

# Publish to the local ~/.m2 repo. Signing is skipped automatically when
# SIGNING_KEY / SIGNING_PASSWORD are unset.
./gradlew :core:publishToMavenLocal :selenium:publishToMavenLocal --no-daemon

# Confirm the artifacts landed.
ls ~/.m2/repository/io/furan/sdk-core/0.5.0/
ls ~/.m2/repository/io/furan/sdk-selenium/0.5.0/

# Sanity-check downstream consumers (the T5 example pulls from mavenLocal).
./gradlew -p examples/sdk-selenium-junit5 clean build --no-daemon
```

The example build succeeding against fresh `~/.m2` artifacts proves the
publication is wired correctly end-to-end.

## Notes / caveats

- Native Gradle support for the new Central Portal is still maturing. The
  `central-publishing-maven-plugin` is a Maven plugin, not a Gradle one. We
  point `publishing { repositories { maven { ... } } }` at the Portal upload
  URL directly. If a release fails with an upload-API issue, the fastest
  fallback is to add a curl-driven upload step to `release.yml` that POSTs the
  staged `~/.m2` artifacts to the Portal API; the publication block stays
  unchanged.
- `signing {}` is a no-op when `SIGNING_KEY` / `SIGNING_PASSWORD` are unset,
  which is exactly what we want for local `publishToMavenLocal` dry-runs.
- Never commit `private.asc`, user tokens, or passphrases. All four secrets
  live in GitHub Actions org-level secrets.
