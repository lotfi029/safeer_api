# Deploying to the VPS (Docker, behind the edge Caddy)

The production runbook. Safeer runs on the association's Hostinger VPS
(Ubuntu, Docker) as its own Compose project, `safeer`, in `/srv/safeer`. It
sits behind the Caddy that the VPS's `edge` project (`/srv/edge`) already
runs on ports 80/443. Another project already runs behind the same Caddy;
nothing here touches it.

```
visitor ─HTTPS─▶ Caddy (edge) ─▶ safeer-web:4000 ─▶ api:3900 ─▶ db:3306
                 TLS, sets XFF    TRUST_PROXY=1      TRUST_PROXY=1  mysql:8.4
                 [edge network]   [edge + safeer]    [safeer]       [safeer]
```

- **Images** come from GHCR: `ghcr.io/lotfi029/safeer-api` (this repo's
  `.github/workflows/image.yml`) and `ghcr.io/lotfi029/safeer-web` (safeer_web's).
  Each repo pushes `:<tag>` on a `v*` tag, and `:sha-<short>` on every publish
  (`image.yml`); `vps-deploy.yml` pushes `:<12-hex commit>` on every push to
  `main` and releases it (§8).
- **Files:** the stack is [`deploy/`](../../deploy/README.md):
  - `docker-compose.yml`
  - three env templates
  - `create-app-db-user.sql`
  - two Caddy blocks
  - `backup.sh`
  - `deploy.sh`, the one entry point for install, releases, migrations and status
- **Network:** nothing publishes a port. The API and MySQL are reachable only
  on the private `safeer` network; the web server only through Caddy.
- **Client IPs:** Caddy keeps no `trusted_proxies`, so it replaces any
  client-sent `X-Forwarded-For`. The web server overwrites it again, and the
  API trusts exactly one hop, so `ip_hash` and the per-IP rate limits see
  the real visitor.

[`DEPLOYMENT-HOSTINGER.md`](DEPLOYMENT-HOSTINGER.md) (Node.js hosting +
MariaDB) is superseded for production. Its sections on `APP_ENCRYPTION_KEY`,
migrations and data retention still apply as written; they're linked below
rather than repeated.

`<VPS_IP>` below is the VPS's public address (hPanel → VPS → Overview). It is
deliberately not written in this public repo.

---

## 1. Prerequisites (once)

1. **Hostinger firewall (S6).** In hPanel → VPS → Security → Firewall, create
   a firewall, attach it to the VPS, and allow inbound only:

   | Port | Protocol | Source |
   |---|---|---|
   | 22 | TCP | your own IP(s) only, if practical |
   | 80 | TCP | any (ACME challenges and the HTTPS redirect) |
   | 443 | TCP | any |
   | 443 | UDP | any (HTTP/3) |

   Docker-published ports bypass `ufw`, so the Hostinger firewall is the
   reliable layer. Safeer publishes none, but don't count on that alone.

2. **The host clock is UTC.** `timedatectl` should show `Time zone: Etc/UTC`.
   The app's nightly maintenance runs at 03:00 UTC (its container is UTC).
   The backup cron (§6) runs at 03:30 host time, so the two only line up on
   a UTC host. Fix with `timedatectl set-timezone Etc/UTC`.

3. **GHCR login.** The other project already pulls from GHCR, so check with
   `docker pull ghcr.io/lotfi029/safeer-api:<tag>`. If that's denied (the
   repos are private), create a classic GitHub token with only
   `read:packages`, then:
   `echo <token> | docker login ghcr.io -u <github-user> --password-stdin`.

4. **The edge network's name (`EDGE_NETWORK`).**
   ```bash
   docker network ls
   grep -A5 '^networks:' /srv/edge/docker-compose.yml
   docker inspect -f '{{json .NetworkSettings.Networks}}' $(docker compose -f /srv/edge/docker-compose.yml ps -q caddy)
   ```
   Use the network the Caddy container is attached to. A network `web`
   declared in the edge project is usually named `edge_web`. If Caddy only
   sits on the edge project's default network, that's `edge_default`.

5. **How the edge Caddy loads its config.** Read
   `/srv/edge/docker-compose.yml` to see which host file or directory is
   mounted at `/etc/caddy/`. §3 adds Safeer's block there.

6. **DNS (owed by the client, review B4).** Before staging, an `A` record
   (and `AAAA`, if the VPS has IPv6) for `new.safeer-sa.org` → `<VPS_IP>`.
   The apex and `www` move only at cutover (§7).

## 2. First deploy

```bash
sudo mkdir -p /srv/safeer && cd /srv/safeer
# from a checkout of this repo at the release tag:
cp deploy/docker-compose.yml deploy/backup.sh deploy/deploy.sh /srv/safeer/
cp deploy/.env.example .env
cp deploy/db.env.example db.env
cp deploy/app.env.example app.env
chmod 600 .env db.env app.env && chmod 700 backup.sh deploy.sh
```

Fill in the three files. Each variable's comment says how to generate it.

- `.env`:
  - `SAFEER_API_TAG` / `SAFEER_WEB_TAG`: a published tag, e.g. `v1.0.0`, or
    the 12-hex commit tag a manual run of `vps-deploy.yml` printed
  - `EDGE_NETWORK`
  - `SITE_URL=https://new.safeer-sa.org` (staging first)
  - `MIGRATION_DB_PASSWORD`
- `db.env`: `MYSQL_ROOT_PASSWORD`.
- `app.env`:
  - `DB_PASSWORD` (the app user's)
  - `APP_ENCRYPTION_KEY`
  - `IP_HASH_SALT`
  - `BOOTSTRAP_ADMIN_EMAIL` (the real first admin) and `BOOTSTRAP_ADMIN_PASSWORD`

> **`APP_ENCRYPTION_KEY`: store a copy offline before the first start**
> (the association's password manager). It encrypts applicant ID numbers and
> the SMTP/SMS secrets. Lose it and that data is unreadable, including in
> every backup. Never reuse the value in `.github/workflows/ci.yml`; it is
> public. See [APP_ENCRYPTION_KEY](DEPLOYMENT-HOSTINGER.md#app_encryption_key).

Then run `./deploy.sh init`. It refuses if the `safeer_dbdata` volume already
exists, and does, in this order (the app user's table grants need the tables,
so it is created after the first migrate, and `schema:check` runs as that
user):

1. `docker compose pull`, then starts `db` and waits for healthy;
2. `docker compose run --rm migrate`, as the migration account (DDL);
3. creates the least-privilege runtime account `'safeer_app'@'%'` from the
   API image's own `deploy/create-app-db-user.sql`, with `DB_PASSWORD` from
   `app.env` (it must be hex: `openssl rand -hex 24`). Neither password
   appears on a command line;
4. `npm run schema:check` as `safeer_app`;
5. starts `api` and waits for `/health/ready`, then starts `web`.

```bash
cd /srv/safeer
./deploy.sh init
./deploy.sh status          # db, api, web: "healthy"; no ports listed; ready: 200
```

`npm run migrate` refuses to run with a different `APP_ENCRYPTION_KEY` than
the database was encrypted with (A7). If you see that message, fix `app.env`;
don't work around it.

## 3. Add the site to Caddy (staging)

Use **one** of the two blocks, never both:
`deploy/Caddyfile.safeer.staging` before cutover,
`deploy/Caddyfile.safeer.prod` after. A block for a host whose DNS doesn't
point here yet makes Caddy retry its certificate until Let's Encrypt
rate-limits it.

Add the block where §1.5 found the edge config:
- If a directory is mounted, copy the file there and add one `import` line
  to the main Caddyfile, e.g. `import sites/*.caddy`.
- If only a single Caddyfile is mounted, paste the block into it.

Then validate and reload, without restarting the other sites:

```bash
cd /srv/edge
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec caddy caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose logs --tail=50 caddy      # the certificate for new.safeer-sa.org is obtained
```

(The review named the container `edge-caddy-1`; `docker exec edge-caddy-1 …`
works the same.)

## 4. Verification

Run after the first deploy, after cutover, and after every update. `$SITE`
is `SITE_URL`.

```bash
SITE=https://new.safeer-sa.org

# The web server, and the API through it (/api/** is proxied):
curl -sS -o /dev/null -w '%{http_code}\n' $SITE/healthz          # 200
curl -sS $SITE/api/v1/site | head -c 300; echo                   # JSON
curl -sS -o /dev/null -w '%{http_code}\n' $SITE/ar               # 200, a rendered page
curl -sS -o /dev/null -w '%{http_code}\n' https://www.${SITE#https://}   # prod only: 301 to the apex

# Security headers on a page and on an API response:
curl -sSI $SITE/ar | grep -iE 'strict-transport|content-security|x-content-type'
curl -sSI $SITE/api/v1/site | grep -iE 'strict-transport|content-security|x-content-type'

# Admin sign-in (the bootstrap admin, or a real account later):
curl -sS -c /tmp/sf.txt -X POST $SITE/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin email>","password":"<password>"}' | head -c 200; echo
grep -c sf_sid /tmp/sf.txt          # 1: the HttpOnly; Secure; SameSite=Strict cookie
curl -sS -b /tmp/sf.txt $SITE/api/v1/admin/overview | head -c 200; echo
rm -f /tmp/sf.txt

# Production-only behaviour:
curl -sS -o /dev/null -w '%{http_code}\n' $SITE/api/docs          # 404 (no Swagger)

# Readiness (the API isn't published, so ask it from inside):
cd /srv/safeer && docker compose exec -T api node -e \
  "fetch('http://127.0.0.1:3900/health/ready').then(r=>r.text()).then(console.log)"
# {"status":"ok","checks":{"database":"up","storage":"up"}}
```

**Nothing but 22/80/443 is reachable from outside.** From another machine,
not the VPS:

```bash
for p in 3900 4000 3306; do nc -vz -w5 <VPS_IP> $p; done   # every one must fail
```

And on the VPS, no Docker port bindings for the stack:

```bash
docker compose -f /srv/safeer/docker-compose.yml ps --format '{{.Name}} {{.Ports}}'
# no "0.0.0.0:" or "[::]:" in any line
sudo ss -ltnp | grep -E ':(3900|4000|3306)\b'               # nothing
```

**Real client IPs over IPv4 and IPv6 (S7).** From one machine that has both
(or two networks), sign up to the newsletter once over each protocol. The
two `ip_hash` values must differ.

```bash
now=$(($(date +%s)*1000 - 10000))
for v in 4 6; do
  curl -$v -sS -X POST $SITE/api/v1/newsletter -H 'Content-Type: application/json' \
    -d "{\"email\":\"s7-ipv$v@<a mailbox you own>\",\"formRenderedAt\":$now}"; echo
done
cd /srv/safeer && docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" safeer -e \
  "SELECT email, ip_hash FROM newsletter_subscribers WHERE email LIKE \"s7-ipv%\""'
```

- **Different hashes:** OK. Delete the two rows (`DELETE … WHERE email LIKE 's7-ipv%'`).
- **The same hash, or every IPv6 visitor hashing alike:** IPv6 connections
  reach Caddy from Docker's gateway address rather than the client's, so all
  IPv6 visitors share one rate limit.
  1. Enable IPv6 NAT in `/etc/docker/daemon.json`:
     `{"ipv6": true, "ip6tables": true}` (and `"userland-proxy": false` if
     it's set to true).
  2. `systemctl restart docker`.
  3. Recreate the edge stack, then test again.

  This is a host-level change that affects the other project too. Plan it.

## 5. Staging acceptance

On `new.safeer-sa.org`:

1. Configure SMTP in the admin (Settings → Mail) and send the test mail.
   Without mail, invites and password resets can't go out.
2. One real journey, end to end:
   1. apply
   2. OTP by email
   3. upload the documents and submit
   4. review in the admin
   5. book an interview
   6. record the decision
3. Invite one staff account and accept it from the emailed link (this checks
   that `SITE_URL` reached `FRONTEND_BASE_URL`).
4. **Delete the test application** from the admin
   (`DELETE admin/applications/:id`, which anonymises it). Remove any other
   test data before cutover.

## 6. Backups

`/srv/safeer/backup.sh` writes the files below to `/srv/safeer/backups`
(mode 700, files 600). It deletes anything older than 14 days.

- a `mysqldump --single-transaction` of `safeer`, gzip
- a tar of the `storage` volume (uploads and applicant documents)

Its header holds the full restore procedure.

```bash
# root's crontab (crontab -e), host clock UTC (§1.2):
30 3 * * * /srv/safeer/backup.sh >> /var/log/safeer-backup.log 2>&1
```

- **Offsite.** Set `OFFSITE_HOOK=/srv/safeer/offsite.sh` in the cron line.
  It's called with the two new files; for example, `rclone copy` to an
  encrypted (`crypt`) remote. The files contain applicant personal data, so
  never send them anywhere unencrypted. Backups keep deleted data for their
  14 days; the privacy notice should say so.
- **Test restore (do it once before go-live, then after any change to
  backup.sh).** Restore the latest dump into a scratch schema and compare:
  ```bash
  cd /srv/safeer && f=$(ls -t backups/safeer-db-*.sql.gz | head -1)
  docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
    "CREATE DATABASE safeer_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"'
  gunzip -c "$f" | docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" safeer_restore_test'
  docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
    "SELECT COUNT(*) FROM safeer.applications; SELECT COUNT(*) FROM safeer_restore_test.applications;"'
  docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE safeer_restore_test"'
  tar -tzf $(ls -t backups/safeer-storage-*.tar.gz | head -1) | head
  ```
  A real restore needs the same `APP_ENCRYPTION_KEY`; the API refuses to
  start against data encrypted under another key.

## 7. Cutover

1. The client points `safeer-sa.org` and `www.safeer-sa.org` (A, and AAAA if
   used) at `<VPS_IP>`. Keep a full backup of the WordPress site first.
   Legacy WordPress URLs are already redirected by the app.
2. When `dig +short safeer-sa.org` returns `<VPS_IP>`:
   ```bash
   cd /srv/safeer
   sed -i 's#^SITE_URL=.*#SITE_URL=https://safeer-sa.org#' .env
   docker compose up -d          # recreates api and web with the new URLs
   ```
3. In the edge config, replace the staging block with
   `Caddyfile.safeer.prod` (apex, plus `www` → apex), then validate and
   reload (§3). Remove the staging DNS record afterwards if it isn't needed.
4. Run all of §4 again with `SITE=https://safeer-sa.org`.
5. **HSTS `includeSubDomains`.** The API and the web server both send it, so
   once a browser has visited the apex, it will refuse plain HTTP on *every*
   `*.safeer-sa.org` subdomain. Confirm with the client that none still
   serves HTTP only (mail webmail, an old portal) before cutover.

## 8. Updates

**Auto-deploy.** Each repo's `.github/workflows/vps-deploy.yml` builds the
image on a push to `main`, pushes `:<12-hex commit>`, and runs
`deploy.sh api|web <tag>` over SSH. `deploy.sh` pulls, swaps that one
container, waits for it to be healthy (the API also for `/health/ready`), and
otherwise puts the previous tag back. A failed release leaves the previous
version serving and the workflow run red.

- It only runs once the repository variable `VPS_ENABLED` is `true`, with
  four **repository** secrets: `VPS_HOST`, `VPS_USER` (`deploy`),
  `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` (`ssh-keyscan <VPS_IP>`).
- The key is a dedicated one, restricted on the VPS to `deploy.sh`; it can
  request only `api <tag>` or `web <tag>`. Its `authorized_keys` line, for the
  `deploy` user:

  ```
  command="/srv/safeer/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… safeer-deploy
  ```

  Test it: `ssh -i <key> deploy@<VPS_IP> status` prints `refused: …`.

**A release with a migration.** `deploy.sh api <tag>` refuses while that
image has pending migrations (the run goes red, the old API keeps serving).
On the VPS:

```bash
cd /srv/safeer
./deploy.sh migrate <tag>     # backup.sh first, then migrate, then the app user's grants + schema:check
./deploy.sh api <tag>
```

`migrate` re-applies the grants from that image's
`deploy/create-app-db-user.sql`, so a table a new migration creates is granted
to `safeer_app` before the new API needs it.

**By hand** (a release tag, or a rollback): `./deploy.sh api v1.1.0` /
`./deploy.sh web v1.1.0`. Then the short form of §4: `/healthz`,
`/api/v1/site`, and the admin sign-in. On SIGTERM the API waits up to 10 s
for in-flight OTP sends; compose allows it 15 s.

## 9. Rollback

- **Code only** (no migration ran): `./deploy.sh api <previous tag>` (or
  `web`). The previous tag is in the last successful workflow run, or in
  `docker image ls ghcr.io/lotfi029/safeer-*`. Every published version stays
  in GHCR.
- **A migration ran.** Migrations are forward-only, so the database goes
  back with the code:
  1. `docker compose stop api web`
  2. Restore the dump `backup.sh` took right before the update (§8). The
     procedure is in `backup.sh`'s header.
  3. Set the previous tags, then `docker compose up -d`.

  Never run older code against a newer schema, or newer code against a
  restored older one.
- **A half-applied migration:** see
  [Recovering from a half-applied migration](DEPLOYMENT-HOSTINGER.md#recovering-from-a-half-applied-migration).
  Use `docker compose run --rm migrate` / `… api npm run migrate:status` for
  the commands.

## 10. After launch

- An uptime monitor on `https://safeer-sa.org/healthz` and
  `https://safeer-sa.org/api/v1/site`.
- Real content and staff invitations.
- Logs: `docker compose logs -f api` (JSON lines; rotated at 10 MB × 5 per
  container).
- Memory: `docker stats`. Docker doesn't use PM2's `max_memory_restart`, so
  watch the web server's memory in the first weeks.

## Reference

- **Data retention** runs inside the API nightly at 03:00 UTC:
  [Data retention](DEPLOYMENT-HOSTINGER.md#data-retention-c27).
- **Migrations** (immutability, the lock, `migrate:status`):
  [Migrations](DEPLOYMENT-HOSTINGER.md#migrations).
- **SMS (Unifonic)** and **S3 storage**: configured in the admin, or in
  `app.env` for S3. See the same-named sections of `DEPLOYMENT-HOSTINGER.md`.
- **One API process.** The in-process cache requires a single instance
  (ARCHITECTURE.md). Don't `docker compose up --scale api=2`.
