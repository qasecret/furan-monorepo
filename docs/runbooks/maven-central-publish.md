# Maven Central publish runbook (sdk-kotlin)

This runbook covers everything needed to publish `io.github.qasecret:furan-core`
and `io.github.qasecret:furan-selenium` to Maven Central via the Sonatype
Central Portal.

The Gradle wiring uses **[`com.vanniktech.maven.publish`](https://github.com/vanniktech/gradle-maven-publish-plugin)**
— the plugin the official Kotlin guide recommends for Maven Central publishing
(see [kotlinlang.org/docs/multiplatform/multiplatform-publish-libraries-to-maven](https://kotlinlang.org/docs/multiplatform/multiplatform-publish-libraries-to-maven.html)
— the steps apply to JVM-only Kotlin libraries too).

## One-time maintainer setup

### 1. Register the `io.github.qasecret` namespace

Sign in to the [Central Portal](https://central.sonatype.com/) using the
"Sign in with GitHub" button (uses the `qasecret` GitHub account). The Portal
will associate `io.github.qasecret` with that account.

1. Avatar menu → **View Namespaces** → **Add Namespace**.
2. Enter exactly `io.github.qasecret`.
3. The Portal returns a **Verification Key** (a short random string).
4. Create a public GitHub repo named after that verification key:
   ```bash
   gh repo create qasecret/<VERIFICATION_KEY> --public \
     --description "Sonatype Central Portal namespace verification"
   ```
5. Back in the Portal, click **Verify Namespace**. Resolves in seconds via
   GitHub OIDC.
6. Once verified, delete the verification repo:
   ```bash
   gh repo delete qasecret/<VERIFICATION_KEY> --yes
   ```

### 2. Generate Portal user token

Portal UI → **View Account** → **Generate User Token**. The Portal shows
two values **once**:

- A **token name** (looks like a username)
- A **token password** (looks like a password)

Copy both into a password manager immediately. These map to the
`MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` GitHub Actions secrets in
step 4.

### 3. Generate a PGP signing key

```bash
gpg --gen-key
# Real name:  Furan Maintainers
# Email:      maintainers@furan.dev
# Passphrase: <pick a strong one — goes into SIGNING_PASSWORD>

# Find the key id (16-char long form)
gpg --list-secret-keys --keyid-format=long
# sec   rsa4096/<LONG_KEY_ID> <date>  [SC]
#       <FINGERPRINT>
# uid   Furan Maintainers <maintainers@furan.dev>

# Take the last 8 characters of LONG_KEY_ID — that's SIGNING_KEY_ID

# Publish the public key so Central Portal can verify signatures
gpg --keyserver keys.openpgp.org --send-keys <LONG_KEY_ID>
# also publish to a second keyserver for redundancy:
gpg --keyserver keyserver.ubuntu.com --send-keys <LONG_KEY_ID>

# Export the private key in ASCII-armored form (vanniktech's
# useInMemoryPgpKeys reads it as text — binary form fails with
# "Cannot perform signing task ... because it has no configured signatory").
gpg --armor --export-secret-keys <LONG_KEY_ID> > /tmp/secring.asc

# Sanity check — the file must begin with the armor header:
head -1 /tmp/secring.asc
# expect: -----BEGIN PGP PRIVATE KEY BLOCK-----
```

Treat `/tmp/secring.asc` like a password — it goes into the
`GPG_KEY_CONTENTS` GitHub Actions secret in step 4, then is shredded.

### 4. Configure GitHub Actions secrets

The `com.vanniktech.maven.publish` plugin reads these five environment
variables (which `release.yml` populates from secrets):

```bash
# Portal token (step 2)
gh secret set MAVEN_CENTRAL_USERNAME --repo qasecret/furan-monorepo
gh secret set MAVEN_CENTRAL_PASSWORD --repo qasecret/furan-monorepo

# PGP key (step 3) — three values
gh secret set SIGNING_KEY_ID --repo qasecret/furan-monorepo
# (paste the last 8 chars of the long key id)

gh secret set SIGNING_PASSWORD --repo qasecret/furan-monorepo
# (paste the passphrase you chose)

gh secret set GPG_KEY_CONTENTS --repo qasecret/furan-monorepo < /tmp/secring.asc
# (the ASCII-armored block; vanniktech reads it as text via useInMemoryPgpKeys)
```

Verify:

```bash
gh api repos/qasecret/furan-monorepo/actions/secrets | jq '.total_count'
# should be >= 5
```

Then shred the local copy:

```bash
shred -u /tmp/secring.asc 2>/dev/null || rm -P /tmp/secring.asc
```

### 5. Verify namespace ownership before the first release

In the Central Portal UI, confirm `io.github.qasecret` is listed as a
verified namespace on the maintainer account. Do this **before** pushing
the first `sdk/v*` tag — the upload will be rejected otherwise.

## Release flow

1. Bump `version=` in `packages/sdk-kotlin/gradle.properties`.
2. Commit + merge to `main`.
3. Push a release tag:
   ```bash
   git tag sdk/v0.5.0
   git push origin sdk/v0.5.0
   ```
4. The tag push triggers [.github/workflows/release.yml](../../.github/workflows/release.yml),
   which runs `./gradlew publishToMavenCentral --no-configuration-cache`.
   The vanniktech plugin handles: signing, sources/javadoc jars, POM
   validation, multi-module aggregation, Portal upload + staging.
   (`publishToMavenCentral` uploads and closes the staging repo but does
   NOT release — `automaticRelease = false` in the build files keeps a
   human in the loop. Use `publishAndReleaseToMavenCentral` instead only
   when we trust the pipeline enough to auto-release on every tag.)
5. Watch the workflow run. On success, the artifacts land in the Central Portal
   **staging** area (auto-release is disabled — `automaticRelease = false`).
6. Open the Central Portal UI → **Deployments**. Verify the staged artifacts
   look right (groupId, artifactId, version, sources + javadoc jars,
   `.asc` signatures present). **Manually promote / release from the Portal
   UI** — auto-release is intentionally off until we have several clean
   releases under our belt.
7. After promotion, expect Maven Central search index propagation to take
   ~15 min – 4 h. The artifact is downloadable immediately even before the
   index updates.

## Dry-run (local, no secrets)

Verify the publish wiring without ever touching Maven Central:

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd packages/sdk-kotlin

# Publish to the local ~/.m2 repo. Signing is auto-skipped when SIGNING_*
# env vars are unset.
./gradlew publishToMavenLocal --no-daemon

# Confirm the artifacts landed.
ls ~/.m2/repository/io/github/qasecret/furan-core/0.5.0/
ls ~/.m2/repository/io/github/qasecret/furan-selenium/0.5.0/

# Sanity-check downstream consumers (the example resolves from mavenLocal).
./gradlew -p examples/sdk-selenium-junit5 clean build --no-daemon
```

The example build succeeding against fresh `~/.m2` artifacts proves the
publication is wired correctly end-to-end.

## Notes / caveats

- The vanniktech plugin's `publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL,
automaticRelease = false)` targets the **new Central Portal** endpoint, not
  the deprecated OSSRH staging API. Sonatype stopped accepting new namespaces
  on OSSRH in 2026.
- Sources + javadoc jars are produced automatically by `KotlinJvm(javadocJar =
JavadocJar.Empty(), sourcesJar = true)`. The empty Javadoc jar satisfies
  Central Portal's requirement without us shipping a meaningless Dokka build
  step.
- The plugin's signing is conditional on `SIGNING_KEY_ID` / `SIGNING_PASSWORD`
  / `GPG_KEY_CONTENTS` env vars being present — `publishToMavenLocal` dry-runs
  skip signing automatically.
- Never commit `secring.gpg`, user tokens, or passphrases. All five secrets
  live in GitHub Actions org-level (or repo-level) secrets only.
- The plugin's full env-var contract is documented at
  https://vanniktech.github.io/gradle-maven-publish-plugin/central/ — defer to
  upstream docs if behavior diverges from this runbook.
