---
title: One-file install (evaluation)
sidebar_label: One-file install
---

# One-file install (evaluation)

One file, one command, no clone and no `.env`:

```bash
curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
docker compose -f furan-compose.yml up -d
# open http://localhost:8080  →  sign in as  admin@furan.local / FuranAdmin123!
```

nginx serves everything on port `8080`: the dashboard at `/`, the API at
`/api` and, from v1.1.34, these docs at `/docs`. Migrations apply themselves from the image
on start. The step-by-step version of this page is
[Getting started](../getting-started/install.md).

## Before it's reachable from a network

The file ships **default credentials and a default JWT secret** for
zero-friction evaluation. Before anything network-reachable, export your own
`FURAN_BOOTSTRAP_ADMIN_PASSWORD`, `JWT_SECRET`, `POSTGRES_PASSWORD` and
`MINIO_ROOT_PASSWORD` before `up`, or keep the defaults off the network with
`FURAN_BIND=127.0.0.1`.

The dashboard works from any browser (`http://<host>:8080`), not just the
Docker host. Over plain http the password and the session cross the network
unencrypted, so beyond a trusted network put HTTPS in front: see
[HTTPS on a domain](../runbooks/reverse-proxy-tls.md).

## Settings

Export any of these before `docker compose -f furan-compose.yml up -d`:

| Variable                                                        | Default                               | What it does                                                                  |
| --------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `FURAN_VERSION`                                                 | the release it pins                   | Which release's images to run.                                                |
| `FURAN_HTTP_PORT`                                               | `8080`                                | The one published port.                                                       |
| `FURAN_BIND`                                                    | `0.0.0.0`                             | The address it listens on; `127.0.0.1` keeps it on the host.                  |
| `FURAN_DASHBOARD_ORIGIN`                                        | `http://localhost:8080`               | The browser origin the API accepts; set it when you use another host or port. |
| `FURAN_BOOTSTRAP_ADMIN_EMAIL`, `FURAN_BOOTSTRAP_ADMIN_PASSWORD` | `admin@furan.local`, `FuranAdmin123!` | The first admin, created on the first boot only.                              |
| `JWT_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`        | evaluation defaults                   | Replace all three before networked use.                                       |

## Point your tests at it

The SDK and REST clients use the same port, under `/api`:

```bash
export FURAN_API_URL=http://<host>:8080/api
```

## Upgrading

The file pins a release, so upgrade by downloading it again into the same
directory and starting it. Your data stays in the Docker volumes, and
migrations apply on start:

```bash
curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
docker compose -f furan-compose.yml up -d
```

Read the release's _Upgrading_ notes in the
[changelog](https://github.com/qasecret/furan-monorepo/blob/main/CHANGELOG.md)
first: some releases need a backup or a step of their own.

If every page returns `502 Bad Gateway` after an upgrade, nginx is still
pointing at the containers the upgrade replaced. Files downloaded before
2026-11-04 don't restart it on their own:
`docker compose -f furan-compose.yml restart nginx` fixes it.

## Something more permanent

For a hardened install that generates its secrets, use
[`deploy.sh`](https://github.com/qasecret/furan-monorepo/blob/main/deploy.sh)
or the [production install](compose.md).
