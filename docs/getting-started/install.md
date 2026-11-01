---
title: 1. Install Furan
sidebar_label: Install
---

# 1. Install Furan

The one-file install runs the whole stack with Docker Compose: no clone, no
`.env`, no secrets to generate. It is the fastest way to evaluate Furan.

## You need

- Docker 24 or later with Compose v2.
- About 4 GB of free RAM and 10 GB of free disk.
- Port `8080` free on the host.

## Steps

1. Download the compose file and start the stack:

   ```bash
   curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
   docker compose -f furan-compose.yml up -d
   ```

2. Wait about a minute for the first start: it pulls the images and applies
   the database migrations.

:::warning Before anyone else can reach it

The file ships **default credentials and a default JWT secret** so it works
with no setup. Before the host is reachable from a network, export your own
values before `up`:

```bash
export FURAN_BOOTSTRAP_ADMIN_PASSWORD='<a strong passphrase>'
export JWT_SECRET="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
export MINIO_ROOT_PASSWORD="$(openssl rand -base64 24)"
docker compose -f furan-compose.yml up -d
```

Or keep the defaults off the network entirely:

```bash
FURAN_BIND=127.0.0.1 docker compose -f furan-compose.yml up -d
```

Over plain http the password and the session cross the network unencrypted.
Beyond a trusted network, put HTTPS in front: see
[HTTPS on a domain](../runbooks/reverse-proxy-tls.md).

:::

## You should see

Every long-running service reports `running`, and the one-shot setup
containers (`minio-perms`, `minio-init`, `migrate`) report `exited (0)`:

```bash
docker compose -f furan-compose.yml ps
```

The API answers its liveness check through the same port as the dashboard:

```bash
curl http://localhost:8080/api/livez
```

Open `http://localhost:8080` in a browser (or `http://<host>:8080` from
another machine) and you get the Furan sign-in page.

## If it doesn't work

- **Port `8080` is taken:** set `FURAN_HTTP_PORT` to another port before `up`,
  and use that port everywhere this guide says `8080`. When you change the
  port, or browse by a host name instead of `localhost`, also set
  `FURAN_DASHBOARD_ORIGIN=http://<host>:<port>` so the API accepts the
  dashboard's origin.
- **A service keeps restarting:** `docker compose -f furan-compose.yml logs <service>`
  shows why. For the API, see [API down](../runbooks/api-down.md).

---

**Next:** [2. Sign in and create a project](create-project.md)
