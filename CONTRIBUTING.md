# Contributing to Furan

Thanks for considering a contribution. Furan is a solo-maintainer OSS project
in early development; small, focused PRs land fastest.

## Dev setup

```bash
git clone https://github.com/qasecret/furan-monorepo && cd furan-monorepo
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Node 22 LTS or newer is required (`engines` in `package.json`; `.nvmrc` pins).

## Branch + commit conventions

- Branch off the default branch; one logical change per branch.
- [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, etc.
- Squash-merge — the PR title becomes the squash commit subject.

## Developer Certificate of Origin (DCO)

We use the DCO, not a CLA. Sign every commit:

```bash
git commit -s -m "feat: short description"
```

The `-s` flag adds a `Signed-off-by:` line that attests you have the right
to submit the change under the project's license (Apache 2.0).

## Pull-request expectations

- Open a draft PR early to surface design questions.
- Tests for any behavior change.
- `pnpm lint` and `pnpm test` green before requesting review.
- Reference relevant ADRs or design docs in [furan-design](https://github.com/qasecret/furan-design).

## Review SLA

Best-effort by a solo maintainer. Most PRs see first feedback within a week.
Security-sensitive PRs may be discussed privately first via the address in
[SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
Report unacceptable behavior to **security@furan.dev**.
