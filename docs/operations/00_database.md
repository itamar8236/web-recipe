# Database runbook

Steps for `recipes-db`. Agents only read this to know what to ask the owner for: running
anything here against production, `npm run db:pull` and `wrangler login` are **owner-only**
(`AGENTS.md` → How to work here). The rules for local data are in the `local-dev` skill.

## Local copies

- `wrangler dev` uses a local SQLite copy in `backend/.wrangler/state` and never touches
  production. Each git worktree has its own copy, empty at first.
- **Refresh the main checkout's copy from production (owner)**: wrangler stays logged out so
  agents can't reach production, so from `backend/`:
  `npx wrangler login`, `npm run db:pull`, `npx wrangler logout`.
  [`scripts/db-pull.mjs`](../../backend/scripts/db-pull.mjs) exports production (read-only)
  to `.wrangler/prod-dump.sql`, replaces the local database with it, then applies
  `schema.sql`. `wrangler d1 execute` refuses statements over 100 KB, which a picture row is,
  so picture rows are inserted afterwards with their bytes bound
  ([`scripts/load-dump.mjs`](../../backend/scripts/load-dump.mjs)).
- **A worktree's copy**: `npm run db:copy-main`
  ([`scripts/db-copy-main.mjs`](../../backend/scripts/db-copy-main.mjs)) replaces it with a
  copy of the main checkout's local database (found through git), then applies `schema.sql`.
  It reads only local files and changes nothing in the main checkout.
- The production dump holds real user data: it's git-ignored; never commit, copy or paste it.

## Production schema (owner)

- New tables: apply `schema.sql`, which is safe to re-run:
  `npx wrangler d1 execute recipes-db --remote --file=schema.sql`.
- Changes to existing tables: run the PR's file in `backend/migrations/` as its top comment
  says, before or after the merge as the PR says. It may break the site for a few moments.

## Running the purge by hand

The daily cron ([Data → Recently deleted](../internals/02_data.md#recently-deleted)) can be run
locally: `npx wrangler dev --test-scheduled --port <8788-8799>`, then open
`/cdn-cgi/handler/scheduled` on that port (`/__scheduled` is served the static 404 page,
since only `/api/*` reaches the Worker).
