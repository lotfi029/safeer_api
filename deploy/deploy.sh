#!/usr/bin/env bash
# deploy/deploy.sh — the one entry point for the Safeer stack on the VPS
# (docs/backend/DEPLOYMENT-VPS.md). Lives in /srv/safeer next to
# docker-compose.yml, backup.sh and the three env files.
#
#   ./deploy.sh init              first install: db, migrate, app user, schema:check, api, web
#   ./deploy.sh migrate <tag>     back up, then apply that API image's pending migrations
#                                 and re-apply the app user's grants (the running API is untouched)
#   ./deploy.sh api <tag>         release an API image  (pull, swap, wait healthy + ready, else roll back)
#   ./deploy.sh web <tag>         release a web image   (pull, swap, wait healthy, else roll back)
#   ./deploy.sh backup            ./backup.sh (database dump + storage archive)
#   ./deploy.sh status            containers, /health/ready, migration status
#
# `api <tag>` refuses while that image has pending migrations: the running API
# keeps serving and nothing changes. A release with a migration is therefore
#   ./deploy.sh migrate <tag> && ./deploy.sh api <tag>
# Migrations are forward-only and never run unattended.
#
# GitHub Actions calls this over SSH with a key whose authorized_keys line forces
#   command="/srv/safeer/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty
# so the requested "api <tag>" / "web <tag>" arrives in SSH_ORIGINAL_COMMAND.
# Only those two, with a 12-hex image tag, are accepted from that path.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

if [[ $# -eq 0 && -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a args <<<"$SSH_ORIGINAL_COMMAND"
  if [[ ${#args[@]} -eq 2 && "${args[0]}" =~ ^(api|web)$ && "${args[1]}" =~ ^[0-9a-f]{12}$ ]]; then
    set -- "${args[@]}"
  else
    echo "refused: only 'api <tag>' or 'web <tag>' over SSH" >&2
    exit 2
  fi
fi

dc() { docker compose "$@"; }
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# A GHCR tag this stack accepts: a release (v1.0.0, v1.0.0-rc1), image.yml's
# sha-<short>, or vps-deploy.yml's 12-hex commit.
valid_tag() { [[ "$1" =~ ^(v[0-9][0-9A-Za-z.-]{0,30}|sha-[0-9a-f]{7,12}|[0-9a-f]{12})$ ]]; }

require_env_files() {
  local f
  for f in .env db.env app.env; do
    [[ -f $f ]] || die "$f missing (copy deploy/$f.example, fill it in, chmod 600)"
  done
  local net
  net=$(get_var EDGE_NETWORK)
  [[ -n "$net" ]] || die "EDGE_NETWORK is empty in .env"
  docker network inspect "$net" >/dev/null 2>&1 || die "edge network '$net' not found (docker network ls)"
}

get_var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
set_var() {
  if grep -qE "^$1=" .env; then sed -i -E "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}

# Waits for a service's container to report healthy (its image HEALTHCHECK).
wait_healthy() {
  local svc=$1 deadline=$((SECONDS + ${2:-180})) id state
  while ((SECONDS < deadline)); do
    id=$(dc ps -q "$svc")
    if [[ -n "$id" ]]; then
      state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
      [[ "$state" == healthy ]] && return 0
      [[ "$state" == unhealthy || "$state" == exited ]] && return 1
    fi
    sleep 3
  done
  return 1
}

# The API's HEALTHCHECK is /health (liveness, no database). Readiness - the
# database and storage both up - is asked separately, from inside the container.
api_ready() {
  local id
  id=$(dc ps -q api)
  [[ -n "$id" ]] || return 1
  docker exec "$id" node -e \
    "fetch('http://127.0.0.1:'+(process.env.PORT||3900)+'/health/ready').then(async r=>{console.log('ready:',r.status,await r.text());process.exit(r.ok?0:1)},e=>{console.log('ready: unreachable',e.message);process.exit(1)})"
}

# Prints [pending]/[CHANGED] lines for SAFEER_API_TAG's migrations (exported by
# the caller); exit status is migrate:status's own.
migration_status() {
  dc run --rm -T migrate npm run --silent migrate:status
}

# The least-privilege runtime account. CREATE USER IF NOT EXISTS plus GRANTs,
# so re-running it is safe and picks up the grant line of any table a new
# migration created. The SQL comes from the image itself, so it always matches
# that image's migrations. The password goes in through sed on a pipe and the
# root password is read inside the container: neither is on a command line.
apply_app_grants() {
  local pw sql
  pw=$(grep -E '^DB_PASSWORD=' app.env | cut -d= -f2-)
  [[ "$pw" =~ ^[A-Za-z0-9]+$ ]] || die "DB_PASSWORD in app.env must be letters and digits only (openssl rand -hex 24)"
  sql=$(dc run --rm --no-deps -T --entrypoint cat api deploy/create-app-db-user.sql) ||
    die "could not read deploy/create-app-db-user.sql from the API image"
  [[ "$sql" == *CHANGE_ME_BEFORE_USE* ]] || die "unexpected create-app-db-user.sql in the API image"
  # shellcheck disable=SC2016  # expands inside the db container, on purpose
  printf '%s\n' "${sql//CHANGE_ME_BEFORE_USE/$pw}" |
    dc exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot'
  unset pw sql
  log "app user grants applied"
  dc run --rm --no-deps -T api npm run --silent schema:check
}

release() {
  local svc=$1 tag=${2:-} var prev
  valid_tag "$tag" || die "bad tag '$tag'"
  var=$([[ $svc == api ]] && echo SAFEER_API_TAG || echo SAFEER_WEB_TAG)
  prev=$(get_var "$var")
  [[ "$prev" == "$tag" ]] && { log "$svc is already on $tag"; return 0; }
  log "$svc: ${prev:-none} -> $tag"
  set_var "$var" "$tag"
  if ! dc pull "$svc"; then
    set_var "$var" "$prev"
    die "pull failed; still on ${prev:-none}"
  fi
  if [[ $svc == api ]]; then
    local st
    if ! st=$(migration_status); then
      set_var "$var" "$prev"
      printf '%s\n' "$st" >&2
      die "could not read the migration status for $tag; still on ${prev:-none}"
    fi
    if grep -qE '^\[(pending|CHANGED)\]' <<<"$st"; then
      set_var "$var" "$prev"
      grep -E '^\[(pending|CHANGED)\]' <<<"$st" >&2
      die "api $tag needs migrations; still on ${prev:-none}. Run: ./deploy.sh migrate $tag && ./deploy.sh api $tag"
    fi
  fi
  dc up -d --no-deps "$svc"
  if wait_healthy "$svc" && { [[ $svc != api ]] || api_ready; }; then
    log "$svc $tag is healthy"
    docker image prune -f >/dev/null
    return 0
  fi
  log "$svc $tag did not become healthy - last log lines:"
  dc logs --tail 40 "$svc" || true
  set_var "$var" "$prev"
  dc up -d --no-deps "$svc"
  wait_healthy "$svc" || log "rollback to ${prev:-none} is not healthy either - check by hand"
  die "$svc rolled back to ${prev:-none}"
}

cmd_init() {
  require_env_files
  local api_tag web_tag
  api_tag=$(get_var SAFEER_API_TAG)
  web_tag=$(get_var SAFEER_WEB_TAG)
  valid_tag "$api_tag" || die "set SAFEER_API_TAG in .env (a published tag)"
  valid_tag "$web_tag" || die "set SAFEER_WEB_TAG in .env (a published tag)"
  if docker volume inspect safeer_dbdata >/dev/null 2>&1; then
    die "volume safeer_dbdata already exists - init only sets up an EMPTY stack. Nothing changed."
  fi
  log "pulling images"
  dc --profile ops pull
  log "starting the database"
  dc up -d db
  wait_healthy db 300 || die "database did not become healthy"
  log "applying migrations (migration account)"
  dc run --rm -T migrate
  apply_app_grants
  dc up -d api
  { wait_healthy api && api_ready; } || { dc logs --tail 60 api; die "api did not become ready"; }
  dc up -d web
  wait_healthy web || { dc logs --tail 60 web; die "web did not become healthy"; }
  log "done - sign in with BOOTSTRAP_ADMIN_EMAIL from app.env, then change its password"
  cmd_status
}

# migrate <tag>: backs up, then runs THAT image's migrations and re-applies the
# app user's grants, without touching the running containers. Release it next
# with `./deploy.sh api <tag>`.
cmd_migrate() {
  require_env_files
  local tag=${1:-}
  valid_tag "$tag" || die "usage: ./deploy.sh migrate <tag>"
  export SAFEER_API_TAG=$tag
  dc --profile ops pull migrate
  log "backing up first (the rollback point - migrations are forward-only)"
  ./backup.sh
  log "applying pending migrations from safeer-api:$tag"
  dc run --rm -T migrate
  apply_app_grants
  log "migrations applied - now: ./deploy.sh api $tag"
}

cmd_status() {
  dc ps
  api_ready || true
  migration_status | grep -vE '^\[applied\]' || true
  log "api $(get_var SAFEER_API_TAG), web $(get_var SAFEER_WEB_TAG)"
}

case "${1:-}" in
  init) cmd_init ;;
  api | web) require_env_files; release "$1" "${2:-}" ;;
  migrate) cmd_migrate "${2:-}" ;;
  backup) require_env_files; ./backup.sh ;;
  status) require_env_files; cmd_status ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
