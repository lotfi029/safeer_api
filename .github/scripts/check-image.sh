#!/usr/bin/env bash
# .github/scripts/check-image.sh — proves a built safeer-api image works the
# way docs/backend/DEPLOYMENT-VPS.md uses it, against a real mysql:8.4:
#
#   1. migrate as the migration user (docker run --rm … npm run migrate)
#   2. create the least-privilege app user (deploy/create-app-db-user.sql)
#   3. schema:check as the app user
#   4. start the API as the app user; /health/ready must report ok
#   5. backup:storage writes a tarball
#   6. no build/test tooling in the image, and it runs as `node`
#
# Usage: .github/scripts/check-image.sh <image>   (ci.yml's `image` job)
# Every value below is a throwaway, CI-only one, like ci.yml's own.
set -euo pipefail

IMAGE="${1:?usage: check-image.sh <image>}"
MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.4}"
NAME="safeer-imgcheck-$$"
NET="$NAME-net"
DB="$NAME-db"
API="$NAME-api"
WORK="$(mktemp -d)"
ROOT_PW="ci-root-$$"
MIGRATOR_PW="ci-migrator-$$"
APP_PW="ciapp$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- api logs ---"; docker logs "$API" 2>&1 | tail -50 || true
    echo "--- db logs ---"; docker logs "$DB" 2>&1 | tail -20 || true
  fi
  docker rm -f "$API" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$NAME-storage" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

step() { echo; echo "==> $*"; }

# One complete, production-shaped env (loadEnv() refuses to start the app or
# the scripts without all of it). DB_USER is the app user; the migrate step
# adds MIGRATION_DB_*.
cat > "$WORK/app.env" <<EOF
NODE_ENV=production
DB_HOST=$DB
DB_PORT=3306
DB_NAME=safeer
DB_USER=safeer_app
DB_PASSWORD=$APP_PW
APP_ENCRYPTION_KEY=ukhiU9W4qpmJr9pwnzL01FaECwZTTOF3Y2vPKga7xrk=
BOOTSTRAP_ADMIN_EMAIL=admin@safeer-sa.org
BOOTSTRAP_ADMIN_PASSWORD=ci-only-password-not-a-secret
IP_HASH_SALT=ci-only-salt-not-a-secret
FRONTEND_BASE_URL=https://safeer.test
CORS_ORIGINS=https://safeer.test
EOF

step "mysql 8.4 on a private network (no published port)"
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" -e MYSQL_DATABASE=safeer \
  -e MYSQL_USER=safeer_migrator -e MYSQL_PASSWORD="$MIGRATOR_PW" \
  "$MYSQL_IMAGE" --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
for i in $(seq 1 90); do
  # The image's entrypoint restarts mysqld once after initialising; wait for
  # the final server (the TCP check fails during the init-only phase, which
  # listens on the socket only).
  if docker exec "$DB" sh -c 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1; then break; fi
  [ "$i" = 90 ] && { echo "mysql did not come up"; exit 1; }
  sleep 2
done
docker exec "$DB" mysql -V

step "1. migrate (migration user)"
docker run --rm --network "$NET" --env-file "$WORK/app.env" \
  -e MIGRATION_DB_USER=safeer_migrator -e MIGRATION_DB_PASSWORD="$MIGRATOR_PW" \
  "$IMAGE" npm run migrate
docker run --rm --network "$NET" --env-file "$WORK/app.env" \
  -e MIGRATION_DB_USER=safeer_migrator -e MIGRATION_DB_PASSWORD="$MIGRATOR_PW" \
  "$IMAGE" npm run migrate | tee "$WORK/migrate-2.log"
grep -q 'Nothing to migrate' "$WORK/migrate-2.log"

step "2. app user (deploy/create-app-db-user.sql, after migrate)"
sed "s/CHANGE_ME_BEFORE_USE/$APP_PW/" deploy/create-app-db-user.sql \
  | docker exec -i "$DB" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'

step "3. schema:check (app user)"
docker run --rm --network "$NET" --env-file "$WORK/app.env" "$IMAGE" npm run schema:check

step "4. API up, /health/ready ok"
docker volume create "$NAME-storage" >/dev/null
docker run -d --name "$API" --network "$NET" --env-file "$WORK/app.env" \
  -v "$NAME-storage:/data/storage" "$IMAGE" >/dev/null
ready=""
for i in $(seq 1 60); do
  ready="$(docker exec "$API" node -e "fetch('http://127.0.0.1:3900/health/ready').then(r=>r.text()).then(t=>console.log(t),()=>{})" 2>/dev/null || true)"
  case "$ready" in *'"status":"ok"'*) break ;; esac
  [ "$i" = 60 ] && { echo "/health/ready never reported ok: $ready"; exit 1; }
  sleep 1
done
echo "$ready"
# The HEALTHCHECK itself must pass too.
for i in $(seq 1 40); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$API")"
  [ "$health" = healthy ] && break
  [ "$i" = 40 ] && { echo "container health: $health"; exit 1; }
  sleep 2
done
echo "container health: $health"
# Listening on 0.0.0.0 (HOST from the image), so the network can reach it:
docker run --rm --network "$NET" "$IMAGE" node -e \
  "fetch('http://$API:3900/health').then(r=>{console.log('reachable on the network:',r.status);process.exit(r.ok?0:1)},e=>{console.error(e.message);process.exit(1)})"

step "5. backup:storage"
docker exec "$API" npm run backup:storage /tmp/backups
docker exec "$API" sh -c 'ls -l /tmp/backups/safeer-storage-*.tar.gz && tar -tzf /tmp/backups/safeer-storage-*.tar.gz | head -3'

step "6. no dev tooling, non-root"
docker run --rm "$IMAGE" sh -c '
  set -e
  test "$(whoami)" = node
  for tool in nest tsc jest concurrently ts-jest oxlint nodemon; do
    if [ -e "node_modules/.bin/$tool" ]; then echo "dev tool present: $tool"; exit 1; fi
  done
  for pkg in @nestjs/cli typescript jest concurrently; do
    if [ -e "node_modules/$pkg" ]; then echo "dev package present: $pkg"; exit 1; fi
  done
  test ! -e .npmrc
  test -e node_modules/dotenv
  echo "user=$(whoami), no dev tooling, dotenv present"
'

echo; echo "Image check passed: $IMAGE"
