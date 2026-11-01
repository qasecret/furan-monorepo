---
title: 7. Wire it into CI
sidebar_label: "Next: wire it into CI"
---

# 7. Wire it into CI

Everything so far ran from your machine. In CI the same test runs on every
push, and Furan holds the review until someone looks.

## You need

- The test from [step 4](first-upload.mdx) in your repository.
- A Furan server your CI runners can reach.

## Steps

Store the three values as CI secrets, then run your tests as usual:

| Secret             | Value                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `FURAN_API_URL`    | One-file install: `http://<host>:8080/api`. Production install (`compose.yml`): `https://<your-api-host>`. |
| `FURAN_API_TOKEN`  | A token created for CI ([step 3](create-token.md)), labelled after the pipeline.                           |
| `FURAN_PROJECT_ID` | The project's UUID ([step 2](create-project.md)).                                                          |

For GitHub Actions there's a ready-made workflow, with a sticky PR comment
and a `furan/baselines` status check: see
[GitHub Actions](../integrations/github-actions.md).

## You should see

A batch in **Batches** for each CI run, waiting for review whenever a step
changed.

---

**Previous:** [6. Review your first diff](first-diff.md)
