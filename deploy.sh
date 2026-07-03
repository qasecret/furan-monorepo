#!/usr/bin/env bash
#
# deploy.sh — one-command, enterprise-grade Furan deployment (Docker Compose).
#
# Stands up a complete self-hosted Furan instance from scratch on a single
# host: data plane (Postgres + Redis + MinIO/HDD), schema migrations, and all
# five app services — in the right order, with secrets generated safely, health
# gated, and the image<->migration lockstep verified before it reports success.
#
# It wraps the documented compose install (docs/runbooks/production-deploy.md)
# so an operator does not have to hand-assemble the -f/-p/--env-file flags,
# hand-edit .env placeholders, or remember the drift canary.
#
#   ./deploy.sh                        # released images, S3/MinIO, localhost
#   ./deploy.sh --mode from-head       # build the 5 images from THIS checkout
#   ./deploy.sh --storage hdd          # filesystem storage, no MinIO
#   ./deploy.sh --mode from-head --api-url https://api.furan.example.com \
#               --dashboard-origin https://app.furan.example.com
#   ./deploy.sh --down                 # stop the stack (keeps data)
#   ./deploy.sh --destroy              # stop AND wipe all volumes (DESTRUCTIVE)
#
# See --help for the full flag list.
#
set -euo pipefail

# --- resolve locations (runnable from anywhere) ------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
DOCKER_DIR="$REPO_ROOT/infra/docker"
ENV_FILE="$DOCKER_DIR/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
COMPOSE_BASE="$DOCKER_DIR/compose.yml"
COMPOSE_LOCAL="$DOCKER_DIR/compose.local-all.yml"

# --- defaults ----------------------------------------------------------------
MODE="released"            # released | from-head
STORAGE="s3"              # s3 | hdd
PROJECT="${FURAN_PROJECT:-furan}"
API_URL="http://localhost:3000"
DASHBOARD_ORIGIN="http://localhost:3001"
ADMIN_EMAIL="${FURAN_BOOTSTRAP_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${FURAN_BOOTSTRAP_ADMIN_PASSWORD:-}"
ASSUME_YES=0
ACTION="up"               # up | down | destroy
FORCE_LOCKSTEP=0
API_PORT=3000
DASH_PORT=3001

# --- pretty output -----------------------------------------------------------
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_red=$'\033[31m'
c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_blu=$'\033[36m'
log()  { printf '%s==>%s %s\n' "$c_blu$c_bold" "$c_reset" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_ylw" "$c_reset" "$*" >&2; }
die()  { printf '%s fail%s %s\n' "$c_red$c_bold" "$c_reset" "$*" >&2; exit 1; }

usage() {
  sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
  cat <<'EOF'

Flags:
  --mode released|from-head   released: pull the pinned published images (default).
                              from-head: build all 5 images from THIS checkout so
                              they are in lockstep with the local migrations.
  --storage s3|hdd            s3: bundled MinIO (default). hdd: filesystem volume.
  --api-url URL               Public API URL baked into the dashboard browser
                              bundle (from-head only) AND used for SSR. Default
                              http://localhost:3000.
  --dashboard-origin URL      Browser origin allowed by the API CORS allowlist.
                              Default http://localhost:3001.
  --admin-email EMAIL         First-admin bootstrap email (prompted if unset on a
                              fresh .env). Ignored once any user exists.
  --admin-password PASS       First-admin bootstrap password (prompted if unset).
  --project NAME              Compose project name. Default: furan.
  --force-lockstep            Deploy released images even if the checkout's
                              migrations are ahead of the pinned tag (unsafe).
  --yes                       Non-interactive: never prompt.
  --down                      Stop the stack, keep volumes.
  --destroy                   Stop the stack and DELETE all data volumes.
  -h, --help                  This help.
EOF
}

# --- arg parse ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)             MODE="${2:?}"; shift 2 ;;
    --storage)          STORAGE="${2:?}"; shift 2 ;;
    --api-url)          API_URL="${2:?}"; shift 2 ;;
    --dashboard-origin) DASHBOARD_ORIGIN="${2:?}"; shift 2 ;;
    --admin-email)      ADMIN_EMAIL="${2:?}"; shift 2 ;;
    --admin-password)   ADMIN_PASSWORD="${2:?}"; shift 2 ;;
    --project)          PROJECT="${2:?}"; shift 2 ;;
    --force-lockstep)   FORCE_LOCKSTEP=1; shift ;;
    --yes|-y)           ASSUME_YES=1; shift ;;
    --down)             ACTION="down"; shift ;;
    --destroy)          ACTION="destroy"; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "unknown flag: $1 (see --help)" ;;
  esac
done

[ "$MODE" = "released" ] || [ "$MODE" = "from-head" ] || die "--mode must be released|from-head"
[ "$STORAGE" = "s3" ] || [ "$STORAGE" = "hdd" ] || die "--storage must be s3|hdd"

# Compose invocation, assembled once. --env-file because .env lives next to the
# compose file, not in cwd. -p pins the project name so re-runs replace the
# stack instead of forking a second one.
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_BASE")
[ "$MODE" = "from-head" ] && COMPOSE+=(-f "$COMPOSE_LOCAL")

# =============================================================================
# Teardown paths
# =============================================================================
if [ "$ACTION" = "down" ]; then
  log "Stopping stack (project=$PROJECT, volumes preserved)"
  "${COMPOSE[@]}" down --remove-orphans || true
  ok "stopped"; exit 0
fi
if [ "$ACTION" = "destroy" ]; then
  warn "This DELETES all Postgres / Redis / object-store data for project '$PROJECT'."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Type the project name '$PROJECT' to confirm: " confirm
    [ "$confirm" = "$PROJECT" ] || die "aborted"
  fi
  "${COMPOSE[@]}" down -v --remove-orphans || true
  ok "destroyed"; exit 0
fi

# =============================================================================
# 1. Preflight
# =============================================================================
log "Preflight checks"
command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 not available (need Docker 24+ / Compose v2)"
docker info >/dev/null 2>&1 || die "docker daemon not reachable — is Docker running?"
command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate secrets)"
command -v curl >/dev/null 2>&1 || die "curl not found (needed for health checks)"

# Warn on low disk — capture-worker image alone is ~4 GB (chromium).
avail_kb="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')"
if [ "${avail_kb:-0}" -lt 8388608 ]; then
  warn "Less than 8 GB free on $(df -Ph "$REPO_ROOT" | awk 'NR==2{print $NF}'). capture-worker alone is ~4 GB."
fi
ok "docker $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $(docker compose version --short 2>/dev/null || echo '?')"

# =============================================================================
# 2. .env — generate on first run, validate on every run
# =============================================================================
gen_secret() { openssl rand -base64 "${1:-32}" | tr -d '\n'; }

if [ ! -f "$ENV_FILE" ]; then
  log "No infra/docker/.env — generating from .env.example with fresh secrets"
  [ -f "$ENV_EXAMPLE" ] || die "missing $ENV_EXAMPLE"

  # Prompt for admin creds if not provided and interactive.
  if [ -z "$ADMIN_EMAIL" ]; then
    if [ "$ASSUME_YES" -eq 1 ]; then ADMIN_EMAIL="admin@local.test"
    else read -r -p "First-admin email [admin@local.test]: " ADMIN_EMAIL; ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"; fi
  fi
  if [ -z "$ADMIN_PASSWORD" ]; then
    if [ "$ASSUME_YES" -eq 1 ]; then ADMIN_PASSWORD="$(openssl rand -hex 24)"; GEN_ADMIN_PW=1
    else
      read -r -s -p "First-admin password [auto-generate]: " ADMIN_PASSWORD; echo
      [ -n "$ADMIN_PASSWORD" ] || { ADMIN_PASSWORD="$(openssl rand -hex 24)"; GEN_ADMIN_PW=1; }
    fi
  fi

  PG_PW="$(gen_secret 24)"
  MINIO_PW="$(gen_secret 32)"
  JWT="$(gen_secret 48)"

  # Start from the template, then replace every placeholder + set mode knobs.
  # We write values without shell-hostile chars leaking into the file by using
  # awk with argument passing (no interpolation of the secret into the pattern).
  awk \
    -v pgpw="$PG_PW" -v miniopw="$MINIO_PW" -v jwt="$JWT" \
    -v aemail="$ADMIN_EMAIL" -v apass="$ADMIN_PASSWORD" \
    -v storage="$STORAGE" -v apiurl="$API_URL" '
    /^POSTGRES_PASSWORD=/       { print "POSTGRES_PASSWORD=" pgpw; next }
    /^MINIO_ROOT_PASSWORD=/     { print "MINIO_ROOT_PASSWORD=" miniopw; next }
    /^JWT_SECRET=/              { print "JWT_SECRET=" jwt; next }
    /^FURAN_BOOTSTRAP_ADMIN_EMAIL=/    { print "FURAN_BOOTSTRAP_ADMIN_EMAIL=" aemail; next }
    /^FURAN_BOOTSTRAP_ADMIN_PASSWORD=/ { print "FURAN_BOOTSTRAP_ADMIN_PASSWORD=" apass; next }
    /^STORAGE_KIND=/            { print "STORAGE_KIND=" storage; next }
    /^COMPOSE_PROFILES=/        { print "COMPOSE_PROFILES=" storage; next }
    /^NEXT_PUBLIC_API_URL=/     { print "NEXT_PUBLIC_API_URL=" apiurl; next }
    { print }
  ' "$ENV_EXAMPLE" > "$ENV_FILE"

  # FURAN_DASHBOARD_ORIGIN is commented in the template; append the active one.
  {
    echo ""
    echo "# --- set by deploy.sh ---"
    echo "FURAN_DASHBOARD_ORIGIN=$DASHBOARD_ORIGIN"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "wrote $ENV_FILE (chmod 600) — secrets auto-generated"
  [ "${GEN_ADMIN_PW:-0}" -eq 1 ] && warn "Generated admin password: $ADMIN_PASSWORD  (save it now — not shown again)"
else
  log "Using existing infra/docker/.env"
  # Fail closed exactly like the api does: no leftover placeholders.
  if grep -qE '=("?)change-me' "$ENV_FILE"; then
    grep -nE '=("?)change-me' "$ENV_FILE" | sed 's/=.*/=<placeholder>/' >&2
    die ".env still has 'change-me' placeholders — the api refuses to boot. Fill them or delete .env to regenerate."
  fi
  ok ".env present, no placeholders"
fi

# Load .env so the script can read the values it just resolved (e.g. admin email
# for the canary). set -a exports; the file uses ${VAR} interpolation.
set -a; # shellcheck disable=SC1090
. "$ENV_FILE"; set +a
ADMIN_EMAIL="${FURAN_BOOTSTRAP_ADMIN_EMAIL:-$ADMIN_EMAIL}"
ADMIN_PASSWORD="${FURAN_BOOTSTRAP_ADMIN_PASSWORD:-$ADMIN_PASSWORD}"

# =============================================================================
# 3. Lockstep guard (released mode) — the #1 production-deploy footgun
# =============================================================================
# The migrate one-shot applies THIS checkout's migrations. Released images are
# pinned to a tag; if the checkout has advanced past that tag, the new schema
# runs under old app code and every project query 500s while /readyz stays green.
pinned_tag="$(grep -m1 -oE 'furan-api:v[0-9]+\.[0-9]+\.[0-9]+' "$COMPOSE_BASE" | cut -d: -f2 || true)"
if [ "$MODE" = "released" ] && [ -n "$pinned_tag" ]; then
  head_desc="$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo unknown)"
  if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$pinned_tag" >/dev/null 2>&1; then
    ahead="$(git -C "$REPO_ROOT" rev-list --count "$pinned_tag"..HEAD 2>/dev/null || echo 0)"
    if [ "$ahead" -gt 0 ]; then
      warn "Checkout is $ahead commit(s) ahead of the pinned image tag $pinned_tag (HEAD: $head_desc)."
      warn "Released images may be behind the local migrations -> project queries can 500 (image<->migration drift)."
      if [ "$FORCE_LOCKSTEP" -ne 1 ]; then
        die "Refusing released deploy out of lockstep. Use --mode from-head (build images from HEAD), \
check out tag $pinned_tag, or pass --force-lockstep to override."
      fi
      warn "--force-lockstep set: continuing despite drift."
    else
      ok "checkout matches pinned image tag $pinned_tag"
    fi
  fi
fi

# =============================================================================
# 4. Acquire images
# =============================================================================
if [ "$MODE" = "from-head" ]; then
  log "Building 5 app images from HEAD ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')) -> :local"
  build_args=()
  # Only the dashboard bakes a browser URL; pass it when deploying on a domain.
  for app in api capture-worker diff-worker integrations dashboard; do
    log "  build furan-$app:local"
    if [ "$app" = "dashboard" ]; then
      DOCKER_BUILDKIT=1 docker build -f "$REPO_ROOT/apps/$app/Dockerfile" \
        --build-arg "NEXT_PUBLIC_API_URL=$API_URL" \
        -t "qasecret/furan-$app:local" "$REPO_ROOT" \
        || die "build failed: furan-$app"
    else
      DOCKER_BUILDKIT=1 docker build -f "$REPO_ROOT/apps/$app/Dockerfile" \
        -t "qasecret/furan-$app:local" "$REPO_ROOT" \
        || die "build failed: furan-$app"
    fi
  done
  ok "5 images built from HEAD"
else
  log "Pulling pinned released images ($pinned_tag)"
  "${COMPOSE[@]}" pull || die "image pull failed"
  ok "images pulled"
fi

# =============================================================================
# 5. Bring the stack up (compose enforces data-plane -> migrate -> apps order)
# =============================================================================
log "Starting stack (mode=$MODE, storage=$STORAGE, project=$PROJECT)"
"${COMPOSE[@]}" up -d --remove-orphans || die "compose up failed"

# Confirm the one-shots exited cleanly before waiting on the apps.
mig_cid="$("${COMPOSE[@]}" ps -aq migrate 2>/dev/null || true)"
if [ -n "$mig_cid" ]; then
  mig_rc="$(docker inspect -f '{{.State.ExitCode}}' "$mig_cid" 2>/dev/null || echo '?')"
  if [ "$mig_rc" != "0" ]; then
    docker logs "$mig_cid" 2>&1 | tail -20 >&2
    die "migrate one-shot exited $mig_rc — see logs above"
  fi
  ok "migrations applied: $(docker logs "$mig_cid" 2>&1 | tail -1)"
fi

# =============================================================================
# 6. Health-wait
# =============================================================================
wait_http() { # url, name, tries
  local url="$1" name="$2" tries="${3:-60}" i=1
  while [ "$i" -le "$tries" ]; do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then ok "$name reachable ($url)"; return 0; fi
    sleep 2; i=$((i + 1))
  done
  return 1
}
log "Waiting for services to become healthy"
wait_http "http://localhost:$API_PORT/livez" "api /livez" 90 \
  || { "${COMPOSE[@]}" logs --tail 30 api >&2; die "api never became healthy"; }
readyz="$(curl -fsS "http://localhost:$API_PORT/readyz" 2>/dev/null || true)"
echo "     /readyz: ${readyz:-<no response>}"
wait_http "http://localhost:$DASH_PORT/login" "dashboard /login" 60 \
  || warn "dashboard /login not reachable yet — it may still be warming up"

# =============================================================================
# 7. Lockstep canary — the check /readyz can't do (hits a drifted table path)
# =============================================================================
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  log "Drift canary: authenticate + GET /projects (must be 200, not 500)"
  token="$(curl -fsS -X POST "http://localhost:$API_PORT/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
  if [ -z "$token" ]; then
    warn "could not obtain a token (admin may not have seeded, or creds differ) — skipping canary"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/projects" \
      -H "Authorization: Bearer $token" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then ok "GET /projects -> 200 (image<->migration lockstep verified)"
    else die "GET /projects -> $code. Likely image<->migration drift; see docs/runbooks/production-deploy.md §0 and 'docker logs ${PROJECT}-api-1'."; fi
  fi
fi

# =============================================================================
# 8. Summary
# =============================================================================
echo
printf '%s%s Furan is up %s\n' "$c_grn" "$c_bold" "$c_reset"
"${COMPOSE[@]}" ps
cat <<EOF

  Dashboard:  http://localhost:$DASH_PORT
  API:        http://localhost:$API_PORT   (/livez /readyz /openapi.json)
  Admin:      ${ADMIN_EMAIL:-<none seeded>}
  Mode:       $MODE    Storage: $STORAGE    Project: $PROJECT

  Manage:  ./deploy.sh --down          (stop, keep data)
           ./deploy.sh --destroy       (stop + wipe volumes)
  Logs:    docker compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE_BASE logs -f api

  For a domain + HTTPS deploy, see docs/runbooks/reverse-proxy-tls.md
EOF
