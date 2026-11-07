---
name: local-dev
description: How to run, test, and verify web-recipe locally against a local copy of the D1 database, never production. Use whenever running the app or dev servers, testing or verifying a change, or touching the database (schema, queries, seed data, wrangler d1 commands).
---

# Running and testing web-recipe locally

Always work against the **local** D1 database. Production (`recipes-db` on Cloudflare)
holds real users' recipes; only the owner changes it.

## Hard rules
- Never pass `--remote` to `wrangler d1 execute`, `d1 migrations`, or any other write
  command. The only allowed `--remote` is the read-only `d1 export` inside `npm run db:pull`.
- Never add `"remote": true` to `backend/wrangler.jsonc`.
- Never run `wrangler deploy` / `npm run deploy`. Deploys happen only on merge to `main`.
- Production schema or data changes are the owner's job. If one is needed, write it in
  the PR (e.g. "run `npx wrangler d1 execute recipes-db --remote --file=schema.sql`").
- Never run `npx wrangler login` or handle Cloudflare credentials. The owner logs in
  once per machine.
- `backend/.wrangler/prod-dump.sql` contains real user data: never commit it (`.wrangler/`
  is gitignored), copy it elsewhere, or paste its contents in PRs, issues, or chat.

## Start a dev session
1. `cd frontend && npm run build` (the Worker serves `frontend/out`).
2. `cd backend && npm run dev`: copies production to local (`npm run db:pull`), then
   starts `wrangler dev` on http://localhost:8787. Every session starts from fresh data.
3. Optional hot reload: in `frontend/`, set `NEXT_PUBLIC_API_BASE=http://localhost:8787`
   in `.env.local` and run `npm run dev` (http://localhost:3000) alongside the backend.

Other backend commands:
- `npm run dev:keep`: restart without re-pulling, keeping your local test data.
- `npm run db:pull`: reset local data to a fresh copy of production.
- `npm run db:schema:local`: apply `schema.sql` to the local DB only.

If `db:pull` fails because wrangler isn't logged in, don't log in: run
`npm run db:schema:local` then `npm run dev:keep` (empty local DB, add test data through
the app), and say so in the PR.

## Local data
The local DB (`backend/.wrangler/state`) is yours: add, edit, or delete anything to test.
`npm run db:pull` puts it back. Local queries:
`npx wrangler d1 execute recipes-db --local --command="SELECT ..."`.

## Report
In the PR's "How to test", say which DB you used (fresh pull or empty), which commands
you ran, and what you checked in the browser. Never report unrun checks as done.

## Known gap
Workers Builds runs `wrangler preview` for PR branches, and previews use the same D1
binding, i.e. **production**. Once Worker code reads `env.DB`, a PR preview would read
and write real data. Not solved yet; flag it in the PR if your change makes it worse.
