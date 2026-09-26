# CLAUDE.md — safeer_api

Backend for جمعية سفير الدعوية: NestJS 11 + TypeORM + MySQL/MariaDB. Cookie sessions + CSRF, RFC 7807 errors, numbered SQL migrations.

## Read first
- `docs/safeer-design-spec.md` — product and design spec (the source of truth for features)
- `docs/safeer-implementation-prompt.md` — the original build brief (data model, roles, rules)
- `docs/safeer-backend-fr-review.md` — FR review of this repo: gaps B1–B15
- `docs/safeer-backend-fix-prompt.md` — **the current task list** (phases 0–6, items B1–B16)
- `README.md` — setup, env vars, scripts, role matrix

## Rules
- Project docs live in `docs/` and are committed on purpose. Cloud sessions need them, so don't delete or gitignore them.
- New schema or seed changes go in new numbered migrations. Never edit `001`/`002`/`dev/003`.
- After route or DTO changes: `npm run openapi` and commit `openapi.json`.
- Before each commit: `npm run build && npm run lint` (plus `npm test` once the Jest suite exists).
- No invented content (numbers, names, partners, testimonials). Use `[...]` placeholders.
- Work on a branch and open a PR. Never force-push `main`.
