# Contributing to Furan

Thanks for considering a contribution. Furan is a small open-source project;
small, focused PRs land fastest. Not sure where to start? Look for issues
labelled `good first issue`, or open an issue to discuss an idea first.

## Dev setup

Prerequisites: **Node 22** (`.nvmrc`), **pnpm 9.15** (`corepack enable`), and
**Docker** (for Postgres, Redis, and MinIO).

```bash
git clone https://github.com/qasecret/furan-monorepo && cd furan-monorepo
pnpm install          # also installs the lefthook pre-commit hooks
```

Then follow [docs/install/quickstart.md](docs/install/quickstart.md) steps 2–6
to configure `.env`, start the data plane, apply migrations, seed an admin, and
run the api + dashboard with hot reload.

## Running checks and tests

```bash
pnpm lint && pnpm typecheck      # fast, no services needed
pnpm build
```

Unit tests run anywhere. **Integration tests need the data plane** (Postgres,
Redis, S3/MinIO) and read `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `JWT_SECRET` from the
environment (see `.env.example`). Without them those suites are **skipped**,
not passed — check the "skipped" count before trusting a green run.

Integration suites share one database and truncate tables, so run them
serially:

```bash
pnpm turbo run test --concurrency=1
pnpm --filter @furan/api test            # a single package
pnpm --filter @furan/api test -- some-name   # a single test file / name
```

Kotlin SDK: `cd packages/sdk-kotlin && ./gradlew check`.

## Branch + commit conventions

- Branch off `main`; one logical change per branch.
- [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, etc.
- Squash-merge — the PR title becomes the squash commit subject.
- The pre-commit hook runs prettier, lint, typecheck, and gitleaks on staged
  files. Mark deliberately fake secrets in tests with `// gitleaks:allow`.

## Developer Certificate of Origin (DCO)

We use the DCO, not a CLA. Sign every commit:

```bash
git commit -s -m "feat: short description"
```

The `-s` flag adds a `Signed-off-by:` line that attests you have the right
to submit the change under the project's license (Apache 2.0).

## Pull-request expectations

- Open a draft PR early to surface design questions.
- Tests for any behavior change; say how you verified it in the PR.
- Lint, typecheck, and tests green before requesting review.
- Keep a change inside one service where you can (e.g. an api change and the
  dashboard change that uses it are two PRs).

## Review SLA

Best-effort by a small maintainer team. Most PRs see first feedback within a
week. Anything security-sensitive goes through the private channel in
[SECURITY.md](SECURITY.md), not a public PR.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
Report unacceptable behavior privately via the form linked in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#enforcement).
