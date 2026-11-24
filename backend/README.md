# Backend

The Cloudflare Worker for web-recipe, in plain JavaScript: the JSON API, D1, login, the
import Workflow, and serving `../frontend/out`. Read the root `AGENTS.md` first; how it works
is in [`docs/`](../docs/README.md), starting with
[Architecture](../docs/internals/00_architecture.md).

- `src/`: the Worker (`index.js` routes every `/api/*` request).
- `src/import/`: the import Workflow, its models, and `sources/` (one adapter per site).
- `schema.sql`: every table, the source of truth for a new database; `migrations/`: one-off
  changes to existing tables, run by the owner.
- `test/`: Vitest in the Workers runtime on a throwaway local D1 built from `schema.sql`
  (`npm test`; never touches production or `.wrangler/state`).
- `scripts/`: Node scripts for local data ([Database runbook](../docs/operations/00_database.md))
  and `e2e-links.mjs`, which runs real imports through the local app (`local-dev` skill).

Commands are in `AGENTS.md` → Commands; running it locally is the `local-dev` skill.
