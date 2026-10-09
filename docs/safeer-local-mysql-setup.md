# Safeer — Local stack on MySQL (Windows + Docker Desktop)

**Decision:** the project's database is **MySQL**. The target is **MySQL 8.4 LTS**, because MySQL 8.0 reached end of life in April 2026.

**Tested already** (2026-09-28, on real MySQL, not MariaDB): the full backend and frontend suites, with the results below. Run the steps below to get the same stack on your machine.

| Check (on MySQL 8.0.46, strict mode incl. `ONLY_FULL_GROUP_BY`) | Result |
|---|---|
| API build and lint · migrations (20, then a second run that does nothing) · `schema:check` | ✅ · ✅ · ✅ 39 tables |
| API tests | ✅ **508/508** |
| API smoke against the seeded dev DB | ✅ **14/14** |
| Production dry run: prod migrate (no dev data), least-privilege user, prod boot, login, contact write | ✅ |
| Frontend `perf/lighthouse-ci` (Phases 7–10 stack): lint · unit **225** · server **123** · build 139.8 KB | ✅ |
| **Frontend e2e against the real API on MySQL** | ✅ **276/276** (7 mock-only excluded) |

The sandbox could only install MySQL **8.0**. Step 2 below runs **8.4** on your machine, and that run is the final confirmation. No differences affecting the app are expected: the `mysql2` driver supports 8.4's default `caching_sha2_password` authentication.

---

## 1. Prerequisites
- Docker Desktop, running
- Node **24** (the frontend build needs ≥ 22.22.3; the API runs on 22 or 24)
- Both repos cloned side by side:
  - `D:\Freelance\Safeer\repos\safeer_api` (backend)
  - `D:\Freelance\Safeer\repos\safeer_web` (frontend)

## 2. Start MySQL 8.4 plus a mail catcher (PowerShell)
```powershell
docker run -d --name safeer-mysql -p 127.0.0.1:3308:3306 `
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=safeer `
  -v safeer-mysql-data:/var/lib/mysql `
  mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci

docker run -d --name safeer-mailhog -p 127.0.0.1:9026:8025 -p 127.0.0.1:1026:1025 mailhog/mailhog

# wait until ready
do { Start-Sleep 2 } until ((docker exec safeer-mysql mysqladmin -uroot -proot ping 2>$null) -match "alive")
```
Once the MySQL switch prompt below has run, the repo's `docker-compose.yml` does the same thing: `docker compose up -d` in `safeer_api`.

## 3. Backend: configure, seed, run
```powershell
cd D:\Freelance\Safeer\repos\safeer_api
git switch main; git pull          # after PR #6 is merged
npm ci
Copy-Item .env.example .env        # then edit .env as below
```
Set these values in `.env` (dev values only):
```
NODE_ENV=development
PORT=3900
DB_HOST=127.0.0.1
DB_PORT=3308
DB_USER=root
DB_PASSWORD=root
DB_NAME=safeer
APP_ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
IP_HASH_SALT=<any random string>
STORAGE_ROOT=./var/assets
BOOTSTRAP_ADMIN_EMAIL=admin@safeer.local
BOOTSTRAP_ADMIN_PASSWORD=<at least 8 characters>
CORS_ORIGINS=http://localhost:4200
FRONTEND_BASE_URL=http://localhost:4200
```
Then:
```powershell
npm run build
npm run migrate            # creates all tables, then seeds them (see below)
npm run migrate            # must print: Nothing to migrate
npm run schema:check       # must print: Schema matches the entities (39 tables checked)
npm run start:prod         # API on http://localhost:3900
```
**What the seed contains** (`NODE_ENV=development`):

| Table | Rows |
|---|---|
| pages | 11 |
| posts | 6, including 3 "legacy template" posts for the clean-up tool |
| board | 6 |
| partners | 7, dev sample |
| applications | 6, one per status |
| documents | 4 |
| contact messages | 5 |
| mail templates | 16 |

It also writes placeholder files into `var/assets`. In production, only the real seed is applied, with no sample data.

**Check the API in a second terminal:**
```powershell
curl http://localhost:3900/health/ready        # {"status":"ok","checks":{"database":"up","storage":"up"}}
npm run smoke -- --confirm=safeer              # 14/14 passed
```
- Swagger: http://localhost:3900/api/docs (development only).
- Outgoing mail shows in MailHog at http://localhost:9026. To see it there, set SMTP in the admin mail settings to host `127.0.0.1`, port `1026`.

## 4. Backend test suite on MySQL
The tests create their own `<DB_NAME>_test` database on the same server:
```powershell
npm test          # expect 508 passed
```

## 5. Frontend against the local API
```powershell
cd D:\Freelance\Safeer\repos\safeer_web
git switch perf/lighthouse-ci      # the Phase 7–10 stack tip, until the PRs are merged
npm ci
npm run build
$env:API_INTERNAL_URL="http://127.0.0.1:3900"; $env:PUBLIC_SITE_URL="http://localhost:4200"; $env:PORT="4200"; $env:NODE_ENV="production"; $env:TRUST_PROXY="1"
node dist/safeer_web/server/server.mjs
```
- Public site: http://localhost:4200/ar
- Admin: http://localhost:4200/ar/admin/login, with the bootstrap admin from `.env`
- Student portal: apply at `/ar/apply`, then sign in with the OTP shown in MailHog, or via `GET http://localhost:3900/api/v1/__dev/otp/<applicationId>` in development

**The full e2e suite against the real API** uses its own database and starts the API with `NODE_ENV=test`:
```powershell
$env:DB_PORT="3308"; $env:DB_PASSWORD="root"; $env:DB_NAME="safeer_web_e2e"
node scripts/real-api.mjs ../safeer_api --detach
$env:E2E_API_URL="http://127.0.0.1:3900"; $env:SAFEER_API_DIR="../safeer_api"
npx playwright install chromium   # first time only
npx playwright test               # expect 276 passed
```

## 6. Reset or clean up
```powershell
cd D:\Freelance\Safeer\repos\safeer_api
npm run db:reset -- --confirm=safeer     # drop, recreate, re-migrate and re-seed (dev/test only)
docker stop safeer-mysql safeer-mailhog  # stop
docker rm -f safeer-mysql safeer-mailhog; docker volume rm safeer-mysql-data   # delete everything
```

## Troubleshooting
- **`ER_NOT_SUPPORTED_AUTH_MODE` / auth errors:** you're on an old `mysql2`. Run `npm ci` in `safeer_api`.
- **"Illegal mix of collations":** the database wasn't created as `utf8mb4_unicode_ci`. Run `db:reset`.
- **The API refuses to boot with a UTC or `sql_mode` error:** that's the built-in guard. Don't override it; restart the container with the command above.
- **Port 3308 is busy:** change `-p 127.0.0.1:3308` and `DB_PORT` together.
