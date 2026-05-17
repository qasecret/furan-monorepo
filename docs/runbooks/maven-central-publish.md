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

Six secrets total. Five drive the publish step; the sixth lets
release-please's tag creation fire `publish.yml` automatically.

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

# Fine-grained PAT for release-please (step 4b below)
gh secret set RELEASE_PLEASE_TOKEN --repo qasecret/furan-monorepo
```

Verify:

```bash
gh api repos/qasecret/furan-monorepo/actions/secrets | jq '.total_count'
# should be >= 6
```

### 4b. Generate the release-please PAT

GitHub's default `GITHUB_TOKEN` cannot trigger downstream workflows
(anti-loop guard). Without a PAT, release-please's `sdk/v<version>` tag
creation does not fire `publish.yml`, so each release would require a
manual `gh workflow run publish.yml`. The PAT bypasses that.

1. https://github.com/settings/personal-access-tokens/new (must be
   created by the repo owner — `qasecret`)
2. Name: `furan-monorepo-release-please`. Expiration: 1 year recommended.
3. Resource owner: `qasecret`. Repository access: **Only select
   repositories** → `qasecret/furan-monorepo` only.
4. Repository permissions (leave all others "No access"):
   - Contents: Read and write
   - Pull requests: Read and write
   - Workflows: Read and write
5. Generate token. **Copy the `github_pat_...` value immediately** — shown
   once.
6. Paste into the `gh secret set RELEASE_PLEASE_TOKEN ...` prompt above.

Then shred the local copy:

```bash
shred -u /tmp/secring.asc 2>/dev/null || rm -P /tmp/secring.asc
```

### 5. Verify namespace ownership before the first release

In the Central Portal UI, confirm `io.github.qasecret` is listed as a
verified namespace on the maintainer account. Do this **before** pushing
the first `sdk/v*` tag — the upload will be rejected otherwise.

## Release flow

Release is fully automated end-to-end. **No manual version bump, no manual
tagging, no manual Portal click.** The flow is driven by Conventional Commits

- [release-please](https://github.com/googleapis/release-please) + the
  vanniktech plugin's `automaticRelease = true`.

### 1. Use Conventional Commits on PRs to `main`

| Commit prefix                                    | Effect                         |
| ------------------------------------------------ | ------------------------------ |
| `feat: ...`                                      | minor bump (`0.5.0` → `0.6.0`) |
| `fix: ...`                                       | patch bump (`0.5.0` → `0.5.1`) |
| `feat!: ...` _or_ `BREAKING CHANGE: ...` in body | major bump (`0.5.0` → `1.0.0`) |
| `docs: / chore: / test: / ci: / refactor:`       | no bump                        |

Scope is recommended but optional: `feat(sdk): add foo()`. Only commits that
touch `packages/sdk-kotlin/**` are considered by release-please (per its
[path config](../../release-please-config.json)).

### 2. release-please opens a Release PR

On every push to `main`, [.github/workflows/release-please.yml](../../.github/workflows/release-please.yml)
runs and either opens or updates a **Release PR** titled `chore(main): release sdk <version>`.
The Release PR contains:

- Version bump in `packages/sdk-kotlin/version.txt` (driven by the
  `# x-release-please-version` marker on that file's first line)
- Updated `packages/sdk-kotlin/CHANGELOG.md` summarizing every Conventional
  Commit since the last release
- Updated `.release-please-manifest.json`

Review the Release PR like any other PR. The version bump + changelog is
your last "before publish" review checkpoint.

### 3. Merge the Release PR

When you merge the Release PR, release-please immediately:

- Creates the `sdk/v<version>` git tag pointing at the merge commit
- Creates a matching GitHub Release

The tag push triggers [.github/workflows/publish.yml](../../.github/workflows/publish.yml),
which runs `./gradlew publishToMavenCentral` against the Central Portal.
Because `automaticRelease = true` in
[core/build.gradle.kts](../../packages/sdk-kotlin/core/build.gradle.kts) +
[selenium/build.gradle.kts](../../packages/sdk-kotlin/selenium/build.gradle.kts),
the vanniktech plugin stages **and** releases in one step — no manual
Portal click required.

### 4. Wait for Maven Central propagation

After publish.yml goes green, expect:

- **Direct URL download** (`https://repo1.maven.org/maven2/io/github/qasecret/furan-selenium/<ver>/...`):
  usually within a few minutes
- **Maven Central search index** propagation: 15 min – 4 h
- **Mirrors used by Gradle's `mavenCentral()`**: typically 30 min – 4 h

Verify with:

```bash
rm -rf ~/.gradle/caches/modules-2/files-2.1/io.github.qasecret
cd packages/sdk-kotlin/examples/sdk-selenium-junit5
./gradlew --refresh-dependencies build
```

### Manual override (rare)

To cut a release out-of-band (hotfix, force a specific version), bump
`version.txt` + tag manually:

```bash
echo "0.5.1 # x-release-please-version" > packages/sdk-kotlin/version.txt
git add packages/sdk-kotlin/version.txt
git commit -m "chore: release sdk 0.5.1"
git push origin main
git tag sdk/v0.5.1
git push origin sdk/v0.5.1
```

Also update `.release-please-manifest.json` (`packages/sdk-kotlin: "0.5.1"`)
so release-please's next run picks up where you left off.

This bypasses release-please but still hits publish.yml. Prefer the
Conventional-Commits flow when not in a hotfix.

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
