# Alpha 1 — pending

> Status: **Pending — no external alpha installer onboarded in v0.4 cycle.**
> Date: 2026-05-17
> Owner: Author

## Context

Phase 3 (`v0.4-auth+dogfood`) shipped on 2026-05-17 with the full v0.4 UI
surface: `/admin/members`, `/admin/projects/[p]/members`,
`/account/tokens`, `/projects/[p]/settings`, `/projects/[p]/runs`, and the
cmdk command palette. The install documentation is in place —
[`docs/install/quickstart.md`](../install/quickstart.md) and the
[`docs/runbooks/alpha-install.md`](../runbooks/alpha-install.md) template
runbook — but the runbook's measurement table is still empty pending a
real dry-run.

The furan-design roadmap (§9 "Success metrics" → dogfood commitment) calls
for **at least one external small-team alpha install with structured
feedback** by the end of Phase 3. No installer materialized in the v0.4
cycle.

> Note: `furan-design/` lives in a separate repo
> (`/Workspace/furan/furan-design/`), so the roadmap and ADRs cannot be
> linked relatively from inside this monorepo. References below cite by
> document + section name; consult the design repo for the source text.

## Why this is a v1.0 GA blocker

The v1.0 differentiator framing per **ADR-028** ("defer VLM differentiator
to v1.1; v1.0 ships on install + dogfood polish") is exactly "install +
dogfood polish." Without external alpha feedback we are shipping blind
on:

1. Whether the install actually completes within the documented <30 min
   first-time target.
2. Whether the v0.4 CI bootstrap flow (project create via curl, capture
   enqueued via a Node script) is comprehensible to someone who did not
   build the platform — or whether the missing first-class CI ingestion
   is itself the blocker.
3. What documentation gaps exist beyond the maintainer's blind spots
   (terminology, missing prerequisites, surprising error messages,
   etc.).
4. Whether L1+L2-only diff output (no VLM-narrated explanation per
   ADR-028) leaves regressions feeling unexplained to a reviewer who is
   not the test author.

## Mitigation plan for Phase 5

Phase 5 (`v1.0-GA`) MUST onboard **≥1 external alpha installer** and
capture their structured feedback against the 5-question template below
before declaring GA. Phase 5 acceptance criteria should explicitly block
the v1.0 tag until at least one
`docs/feedback/alpha-1-<handle>.md` lands alongside the filled-in
`docs/runbooks/alpha-install.md` measurement.

### 5-question feedback template

1. Did the install complete inside the documented time? (Compare the
   installer's wall-clock against the runbook target.)
2. Could you get from "fresh login" to "first SDK upload + first diff
   visible" without help? Where did you get stuck?
3. What documentation was unclear, missing, or wrong?
4. What still blocks you from running this on a real project (CI,
   notifications, auth model, performance, missing integrations)?
5. Would natural-language diff explanations (the v1.1+ VLM differentiator
   per ADR-028) materially change your answer to (4)?

### Outreach plan

- Twitter / X with `#oss` and `#visualregression` tags.
- An HN "Show HN" post once Phase 4 ships the GitHub App — the "5
  minutes from PR comment to diff" hook is the demo that converts.
- Personal network: ~3 candidates already in mind (concrete list to be
  populated as Phase 4 lands).
- OSS Discord servers in the QA / front-end testing space.

Track the count and outcomes in Phase 5's plan; do not tag `v1.0` until
at least one external installer feedback file is in `docs/feedback/`.

## Status updates

- **2026-05-17**: Pending placeholder created at the end of the v0.4
  cycle; no candidate engaged during Phase 3. Install docs and runbook
  template are in place — the next action is either (a) maintainer
  self-measurement to fill the runbook on a fresh host, or (b) onboarding
  an external installer during Phase 4 and converting this file into
  `alpha-1-<handle>.md`.
