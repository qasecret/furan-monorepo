---
title: REST API upload
sidebar_label: REST API upload
---

# REST API upload

The SDK is a client of a small REST API, and any CI job can drive that API
directly: the client captures the PNG and uploads the bytes. Every call
authenticates with a token (`Authorization: Bearer <token>`, see
[Create a token](../getting-started/create-token.md)).

## The sequence

```bash
API=http://localhost:8080/api   # one-file install; compose.yml: http://localhost:3000
PAT=furan_pat_…                 # your token
PID=…                           # your project ID
# 1. Build
BUILD=$(curl -s -X POST $API/projects/$PID/builds -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' -d '{"branchName":"main","name":"ci-1"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
# 2. Run
RUN=$(curl -s -X POST $API/runs -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PID\",\"buildId\":\"$BUILD\",\"name\":\"smoke\",\"branchName\":\"main\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).runId')
# 3. Upload a screenshot (base64 JSON variant; multipart pngBytes also supported)
curl -s -X POST $API/runs/$RUN/screenshots/base64 -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' \
  -d "{\"pngBase64\":\"$(base64 < shot.png | tr -d '\n')\",\"name\":\"homepage\",\"viewport\":\"1280x720\",\"browser\":\"chromium\"}"
# 4. Complete
curl -s -X POST $API/runs/$RUN/complete -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' -d '{}'
```

1. **Build:** one per CI run. It groups the runs into a batch.
2. **Run:** one per test.
3. **Upload:** one per screenshot (a step). Upload as many as the test takes.
4. **Complete:** tells Furan the run has all its screenshots.

## Keep the identity stable

A step's identity is the run's `branchName` plus the screenshot's `name`,
`viewport`, `browser`, and the optional `os` and `device` fields. The run's
own `name` is not part of it, so keep screenshot names unique in the project.
Reuse the same values on later runs, so they compare against the same
baseline.

The first run of a step has no baseline: it is stored as **New**, and a
reviewer approves it in the dashboard to make it the baseline. See
[Approve your first baselines](../getting-started/first-baseline.md).
