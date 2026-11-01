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

Getting started

## Install and operate

- [Production install and upgrades](runbooks/production-deploy.md)
- [HTTPS on a domain](runbooks/reverse-proxy-tls.md)
- [Storage backends](runbooks/storage-backends.md)
- [Backup and restore](runbooks/restore-from-backup.md)
- [Upgrade notes: per-step review](runbooks/review-model-upgrade.md)
- [Row-level security](runbooks/rls-enable.md)

## CI

- [GitHub Actions](integrations/github-actions.md)

## Troubleshooting

- [API down](runbooks/api-down.md)
- [Diff queue backlog](runbooks/diff-queue-backlog.md)
