# syntax=docker/dockerfile:1
#
# safeer-api — the production image (docs/backend/DEPLOYMENT-VPS.md).
# Built and pushed to ghcr.io/lotfi029/safeer-api by .github/workflows/image.yml;
# ci.yml's `image` job builds it on every PR and runs migrate, schema:check,
# /health/ready and backup:storage against mysql:8.4.
#
# Debian slim (glibc), not Alpine: argon2 and sharp ship prebuilt binaries
# for glibc; on musl they'd need a compiler toolchain in the build stage.
# Pinned to a full version; bump both stages together, at or above
# package.json "engines".

# ---- build: full install (dev tooling included), compile to dist/ --------
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app

# .npmrc (include=dev) is wanted here: `nest build` needs @nestjs/cli and
# typescript.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies only ------------------------------
FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3900 \
    STORAGE_ROOT=/data/storage \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# .npmrc is deliberately NOT copied: its include=dev beats --omit=dev and
# would put nest, typescript, jest and concurrently into this image (and
# their audit findings with them). ci.yml's image job checks they're absent.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts ./scripts
# deploy/deploy.sh re-applies the app user's grants from the image itself, so
# they always match this image's migrations.
COPY deploy/create-app-db-user.sql ./deploy/create-app-db-user.sql

# Uploaded files. Compose mounts the named `storage` volume here. No VOLUME
# instruction: it would add an anonymous volume to every one-off
# `docker run --rm … npm run migrate`.
RUN mkdir -p /data/storage && chown node:node /data/storage

USER node

EXPOSE 3900

# No curl in slim; Node 24 has fetch. /health is liveness only (no DB), so
# a database outage doesn't get the API container restarted in a loop;
# /health/ready is the readiness check the runbook and CI use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3900) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Run node directly (not npm start) so SIGTERM reaches the app and its
# shutdown hooks drain background sends (A4); compose gives it 15 s.
CMD ["node", "dist/main.js"]
