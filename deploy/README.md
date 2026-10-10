# deploy/ — the Safeer stack on the VPS

Docker Compose bundle for the whole stack (mysql:8.4, safeer-api,
safeer-web) behind the VPS's existing edge Caddy. The runbook — first deploy,
staging, cutover, updates, rollback, verification, backups — is
[`docs/backend/DEPLOYMENT-VPS.md`](../docs/backend/DEPLOYMENT-VPS.md).

| File | Goes to | What it is |
|---|---|---|
| `docker-compose.yml` | `/srv/safeer/` | Project `safeer`: `db`, `api`, `web`, and the one-off `migrate` (profile `ops`). No published ports. |
| `.env.example` | `/srv/safeer/.env` | Compose variables: image tags, `EDGE_NETWORK`, `SITE_URL`, the migration account. |
| `db.env.example` | `/srv/safeer/db.env` | MySQL root password (db container only). |
| `app.env.example` | `/srv/safeer/app.env` | The API's settings and secrets, with how to generate each. |
| `create-app-db-user.sql` | run once | The least-privilege runtime account, `'safeer_app'@'%'`, after the first migrate. |
| `Caddyfile.safeer.staging` / `.prod` | the edge Caddy | One of the two, never both. |
| `backup.sh` | `/srv/safeer/` | Nightly DB dump and storage tarball, 14-day retention; restore steps in its header. |

The env files hold secrets: `chmod 600`, never commit the filled-in copies.
`APP_ENCRYPTION_KEY` must also be stored offline.
