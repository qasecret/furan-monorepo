---
slug: /
sidebar_label: Overview
title: Furan documentation
---

# Furan documentation

Furan is self-hosted visual regression testing. Your tests capture
screenshots with the SDK (or plain REST), upload them to your Furan server,
and Furan compares each one against an approved baseline. A person reviews
what changed in the dashboard and approves or rejects it.

## Start here

[Getting started](getting-started/install.md) takes a new team from the
one-file install to its first reviewed diff in seven short pages:

1. [Install Furan](getting-started/install.md)
2. [Sign in and create a project](getting-started/create-project.md)
3. [Create a token](getting-started/create-token.md)
4. [Send your first upload](getting-started/first-upload.mdx)
5. [Approve your first baselines](getting-started/first-baseline.md)
6. [Review your first diff](getting-started/first-diff.md)
7. [Wire it into CI](getting-started/next-ci.md)

## Install and operate

- [One-file install (evaluation)](install/one-file.md)
- [Production install (Docker Compose)](install/compose.md)
- [Production deploy and upgrades](runbooks/production-deploy.md)
- [HTTPS on a domain](runbooks/reverse-proxy-tls.md)
- [Storage backends](runbooks/storage-backends.md)
- [Backup and restore](runbooks/restore-from-backup.md)
- [Upgrade notes: per-step review](runbooks/review-model-upgrade.md)
- [Row-level security](runbooks/rls-enable.md)

## Send screenshots

- [Kotlin SDK](sdk/kotlin.mdx): Selenium, Playwright and Appium
- [REST API upload](sdk/rest.md)

## CI

- [GitHub Actions](integrations/github-actions.md)

## Troubleshooting

- [First-install problems](troubleshooting/first-install.md)
- [API down](runbooks/api-down.md)
- [Diff queue backlog](runbooks/diff-queue-backlog.md)
