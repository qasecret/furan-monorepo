# @furan/cli

`furan upload` sends PNG screenshots to [Furan](https://github.com/qasecret/furan-monorepo),
the self-hosted visual-testing app, waits for the verdict and exits non-zero
when a screenshot needs review.

```bash
npm install --save-dev @furan/cli
export FURAN_API_URL=https://furan.example.com/api FURAN_API_TOKEN=furan_pat_... FURAN_PROJECT_ID=...
npx furan upload screenshots/
```

Each subfolder becomes a test and each PNG a step (`cypress/screenshots` works
as is). Branch, pull-request base and a per-pipeline build id are read from
GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, Azure Pipelines and
Bitbucket Pipelines, so parallel jobs land in one batch.

| Exit | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | passed (a step with no baseline yet passes with a warning)  |
| 1    | a screenshot needs review                                   |
| 2    | bad input or configuration; nothing was sent                |
| 3    | no verdict (the api was unreachable, refused, or timed out) |

**GitHub Action:**

```yaml
- uses: qasecret/furan-monorepo/packages/cli@cli/v0.1.0
  with:
    path: screenshots
    api-url: ${{ secrets.FURAN_API_URL }}
    token: ${{ secrets.FURAN_API_TOKEN }}
    project-id: ${{ secrets.FURAN_PROJECT_ID }}
```

Documentation: [JavaScript / TypeScript guide](https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/javascript.md#furan-upload). License: Apache-2.0.
