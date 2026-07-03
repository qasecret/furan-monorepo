# Runbook — deploying on a domain with HTTPS (reverse proxy + TLS)

> **Audience:** an operator taking the single-host Compose install (see
> [`production-deploy.md`](production-deploy.md)) and exposing it on a real
> domain — e.g. `https://furan.example.com` — for remote users, instead of
> `http://localhost`.
> **Scope:** the one dashboard constraint that makes this non-obvious, the
> config knobs involved, a worked TLS reverse-proxy example (Caddy), and the
> things you must verify in your own environment.

---

## 0. The one thing that makes this non-obvious

The dashboard makes API calls from **two** places, and they resolve the API URL
differently:

| Caller | Reads `NEXT_PUBLIC_API_URL` … | Reachability |
| ------ | ----------------------------- | ------------ |
| **Browser** (client-side JS: diff viewer, live updates) | **baked at image build time** — Next inlines `NEXT_PUBLIC_*` into the client bundle; it **cannot** be changed at runtime | must be reachable **from the end user's browser** |
| **SSR** (server-rendered pages, inside the container) | container env | must be reachable **from inside the Compose network** |

The **published** dashboard image bakes `http://localhost:3000` as the browser
URL (the default in [`apps/dashboard/src/lib/env.ts`](../../apps/dashboard/src/lib/env.ts)).
That is correct for a viewer sitting on the Docker host, but a **remote** user's
browser will try to fetch `http://localhost:3000` — i.e. *their own* machine —
and every client-side feature (the pixi diff viewer, live SSE updates) fails.

**No reverse proxy can fix this**: the URL is a hard-coded absolute string
compiled into the JavaScript. To serve remote users you **must rebuild the
dashboard image** with your public API URL baked in. That is the crux of this
runbook; everything else is standard TLS plumbing.

---

## 1. Choose a topology

Two origins is the clean choice because the dashboard and the API both serve
paths at the root (e.g. both use `/projects`), so a single-origin path split is
collision-prone. Use **two subdomains**, one reverse proxy, one cert each:

```
app.furan.example.com   ->  dashboard  (:3001)
api.furan.example.com   ->  api        (:3000)
```

- Browser loads the app from `app.furan.example.com`; its client-side calls go
  to `api.furan.example.com` (the baked URL — Step 2).
- The API's CORS allowlist must permit the app origin (Step 4).

---

## 2. Rebuild the dashboard with your public API URL

The Dockerfile exposes a build arg (default preserves the localhost image):

```bash
# From the repo root, at the release tag you are deploying.
docker build -f apps/dashboard/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.furan.example.com \
  -t <your-registry>/furan-dashboard:furan.example.com .
```

Push it to a registry your host can pull, or build it on the host. Then point
the `dashboard` service at this image with a small local Compose overlay
(kept next to your `.env`, **not** committed):

```yaml
# infra/docker/compose.domain.yml
services:
  dashboard:
    image: <your-registry>/furan-dashboard:furan.example.com
```

> The other four app images (`api`, `capture-worker`, `diff-worker`,
> `integrations`) do **not** need rebuilding — only the dashboard bakes a
> browser URL. Keep them on the published, signed release tags.

## 3. Terminate TLS with a reverse proxy

Any proxy works; [Caddy](https://caddyserver.com) is shown because it
auto-provisions Let's Encrypt certificates. Add it to the Compose network so it
can reach services by name:

```yaml
# add to infra/docker/compose.domain.yml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes:
  caddy_data:
```

```caddyfile
# infra/docker/Caddyfile
app.furan.example.com {
    reverse_proxy dashboard:3001
}
api.furan.example.com {
    reverse_proxy api:3000
}
```

Point both DNS `A` records at the host, open `80`/`443`, and Caddy fetches certs
on first request. (You no longer need to publish `3000`/`3001` to the host — the
proxy reaches them over the Compose network. Drop those `ports:` mappings for a
tighter surface.)

## 4. Align the runtime env

In `.env`, set the API's CORS allowlist and the dashboard's **runtime** (SSR)
API URL to the public origins:

```bash
# The API's browser-CORS allowlist — must include the dashboard origin.
FURAN_DASHBOARD_ORIGIN=https://app.furan.example.com

# SSR (server-side) API URL. Public URL is the always-correct choice (it
# hairpins out through Caddy and back); an in-network http://api:3000 is a
# valid optimization if you prefer to keep SSR traffic off the proxy.
NEXT_PUBLIC_API_URL=https://api.furan.example.com
```

Bring the stack up with the overlay appended to the §3 command from
`production-deploy.md`:

```bash
docker compose -p furan --env-file infra/docker/.env \
  -f infra/docker/compose.yml \
  -f infra/docker/compose.domain.yml \
  up -d
```

## 5. Verify

```bash
# TLS + both origins answer.
curl -sI https://app.furan.example.com/login   | head -1   # -> 200
curl -s  https://api.furan.example.com/livez               # -> ok

# In a real browser at https://app.furan.example.com: sign in, open a run's
# diff viewer, and confirm the baseline/candidate images render. In devtools
# → Network, the storage image requests must go to
# https://api.furan.example.com/api/v1/storage/... and return 200 — NOT to
# localhost:3000 (that would mean the dashboard was NOT rebuilt in Step 2).
```

The devtools check is the real test: a diff viewer that renders proves the
baked URL, TLS, and CORS all line up.

## 6. Verify in YOUR environment

This runbook nails the dashboard-URL constraint and the transport layer. Two
things depend on your exact setup and should be confirmed against your own
deployment, not assumed:

- **Session cookies across the two subdomains.** The dashboard sets its session
  on `app.furan.example.com`; confirm login persists and authenticated
  client-side calls to `api.furan.example.com` succeed. If they don't, the
  simplest fix is a **single origin** (put the API on a non-colliding path
  prefix your proxy strips, or a dedicated host) so cookies and CORS stay
  same-site.
- **`FURAN_DASHBOARD_ORIGIN` is comma-separated** — add every origin the
  browser will load the app from (staging, vanity domains, etc.).

## 7. Localhost-only alternative (no rebuild)

If remote access is only ever for you, skip all of the above and **SSH-tunnel**:
`ssh -L 3001:localhost:3001 -L 3000:localhost:3000 host`, then browse
`http://localhost:3001`. The published image's baked `localhost:3000` is then
correct because, through the tunnel, the API really is on your `localhost`.

## 8. References

- [production-deploy.md](production-deploy.md) — the base single-host install
- [storage-backends.md](storage-backends.md) — S3 vs HDD
- [`apps/dashboard/src/lib/env.ts`](../../apps/dashboard/src/lib/env.ts) — where the browser URL default lives
