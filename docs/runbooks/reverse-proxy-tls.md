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

The dashboard makes API calls from **two** places. Both resolve the API URL from
the **same build-time-baked** `NEXT_PUBLIC_API_URL`, but they run in different
network namespaces, so one baked value cannot satisfy both:

| Caller                                                                                                              | Where the URL comes from                                                                                                                                                     | Reachability it needs                             |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Browser** (client-side JS: diff viewer, live SSE updates)                                                         | **baked at image build time** — Next inlines `NEXT_PUBLIC_*` into the client bundle                                                                                          | reachable **from the end user's browser**         |
| **SSR / Server Actions** (login, the `home` resolver, every `(protected)` page, admin shell — inside the container) | **also baked at image build time** — Next inlines `NEXT_PUBLIC_*` into the **server** bundle too, so this reads the _same_ frozen literal, **not** the runtime container env | reachable **from inside the dashboard container** |

> ⚠️ **Common misconception (and the reason UI login 500s):** setting
> `NEXT_PUBLIC_API_URL` in the container `environment:` at runtime does **not**
> change the SSR/Server-Action target. `NEXT_PUBLIC_*` is a _build-time_ contract
> — Next replaces every `process.env.NEXT_PUBLIC_API_URL` reference (client **and**
> server) with the literal baked at build. The runtime override in
> `compose.yml`'s `dashboard.environment` is therefore **inert** for a published
> image. Verified 2026-07-09: with `NEXT_PUBLIC_API_URL=http://api:3000` set in
> the container env, the login Server Action still fetched `http://localhost:3000`
> and got `ECONNREFUSED`.

The **published** dashboard image bakes `http://localhost:3000`
(the default in [`apps/dashboard/src/lib/env.ts`](../../apps/dashboard/src/lib/env.ts)).
Two consequences:

- **Server-side is broken even on a same-host `localhost` deploy.** Inside the
  dashboard container, `localhost:3000` is the _dashboard itself_, not the `api`
  container — so login (a Server Action) and every server-rendered `(protected)`
  page get `ECONNREFUSED`. The dashboard **renders** but you **cannot sign in
  through the UI**. (The API, workers, and the SDK/PAT/curl ingestion path are
  fully functional — see [production-deploy.md §4](production-deploy.md#4-verify).)
- **Client-side is broken for remote browsers.** A remote user's browser fetches
  `http://localhost:3000` — _their own_ machine — so the diff viewer and live
  updates fail.

**No reverse proxy or runtime env var can fix either**: the URL is a hard-coded
absolute string compiled into the JavaScript. To get a **usable dashboard** you
**must rebuild the dashboard image** with a public API URL that is reachable from
**both** the browser and the container (a public domain hairpins through the
proxy and satisfies both — Steps 2–4). That is the crux of this runbook;
everything else is standard TLS plumbing.

> **Fixed in `v1.1.28`:** server-side callers now resolve a separate runtime,
> non-`NEXT_PUBLIC_` `API_INTERNAL_URL` (`serverApiUrl()` in
> [`apps/dashboard/src/lib/env.ts`](../../apps/dashboard/src/lib/env.ts); wired in
> `compose.yml` as `API_INTERNAL_URL: ${API_INTERNAL_URL:-http://api:3000}`), so
> a single image serves both the host browser (baked `localhost:3000`) and
> in-container SSR (`http://api:3000`) — UI login works on a plain `localhost`
> deploy. Published images **≤ v1.1.27 are still affected**: upgrade to
> **v1.1.28+**, or build from source (`./deploy.sh --mode from-head`). The domain
> rebuild below remains the path for **remote** browsers (client-side calls still
> need a browser-reachable baked URL).

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

# Keep this ALIGNED with the value you baked in Step 2. Note it is only the
# BAKED value (Step 2's --build-arg) that actually drives both the browser and
# SSR — this runtime var is inert for a built image (see §0), and is set here
# only so `.env` documents one consistent public API origin.
NEXT_PUBLIC_API_URL=https://api.furan.example.com
```

Tell the API to trust the proxy's `X-Forwarded-For`, so login rate limits
(ADR-063) key on the real client IP instead of Caddy's — otherwise every
user behind the proxy shares one 10-attempts/min per-IP bucket. The api
service doesn't forward this variable by default; add it in the overlay:

```yaml
# add to infra/docker/compose.domain.yml
services:
  api:
    ports: !reset [] # reachable only via Caddy (Compose >= 2.24)
    environment:
      TRUST_PROXY: "uniquelocal" # Caddy + the dashboard, on the private Docker network
```

> ⚠️ Trust proxies by **address**. `uniquelocal` (private ranges) is safe here
> because the api is reachable **only** through the proxy — hence the
> `ports: !reset []`. If the api port stays published, list Caddy's exact IP or
> CIDR instead, or any client on a private network could forge
> `X-Forwarded-For`. Hop counts such as `"1"` are rejected at boot — Fastify
> ignores them (ADR-065). With no proxy in front, leave it unset. See
> `.env.example` for the full grammar.

Because both callers use the baked URL, the public origin
(`https://api.furan.example.com`) is the value that works everywhere: the
browser reaches it directly, and the dashboard container's SSR hairpins out
through Caddy and back in. This is why the domain deploy — unlike plain
`localhost` — yields a fully working dashboard.

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
