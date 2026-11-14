---
name: local-dev
description: How to run, test, and verify web-recipe locally against the local copy of the D1 database, never production. Use whenever running the app or dev servers, testing or verifying a change, or touching the database (schema, queries, seed data, wrangler d1 commands).
---

# Running and testing web-recipe locally

Always work against the **local** D1 database (`backend/.wrangler/state`). It's a copy
of production that the owner refreshes. Production (`recipes-db` on Cloudflare) holds
real users' recipes; only the owner reads or changes it.

Assume wrangler is **logged out**: the owner logs in only for a moment to refresh the
local copy, so agents can't reach production even by accident.

## Hard rules
- Never pass `--remote` to any wrangler command, and never run `npm run db:pull`
  (it reads production; it's the owner's command).
- Never run `npx wrangler login` or handle Cloudflare credentials. If wrangler happens to
  be logged in, don't use it for anything remote.
- Never add `"remote": true` to `backend/wrangler.jsonc`.
- Never run `wrangler deploy` / `npm run deploy`. Deploys happen only on merge to `main`.
- Production schema or data changes are the owner's job. If one is needed, write it in
  the PR (e.g. "run `npx wrangler d1 execute recipes-db --remote --file=schema.sql`").
- `backend/.wrangler/prod-dump.sql` contains real user data: never commit it (`.wrangler/`
  is gitignored), copy it elsewhere, or paste its contents in PRs, issues, or chat.
- Never read `backend/.dev.vars` or `.env`. `.dev.vars` holds the owner's dev keys, which
  use a test quota, not production's.
- You may test real imports yourself on the local app, but only on links the owner gives
  in the chat. Pick **Basic** in the dialog's model choice, so testing doesn't use up the
  best model's 20 requests a day. Automated tests always use fake keys and stubs. List in
  the PR the real imports you ran. `node scripts/e2e-links.mjs "<link>" ...` (from
  `backend/`, with the app running) runs the links the owner gave in the chat, or a file of
  them, through the local app on a test account, Basic by default; it's the check after Facebook or Instagram change
  their pages.

## 1. Check the local copy
From `backend/`:
```
npx wrangler d1 execute recipes-db --local --command="SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM folders) AS folders, (SELECT COUNT(*) FROM recipes) AS recipes"
```
If it fails with `no such table`, or every count is 0, the local copy is empty. Stop and
tell the owner, giving them these commands to run themselves from `backend/`:
```
npx wrangler login
npm run db:pull
npx wrangler logout
```
Continue only when they say it's done, or if they tell you to go on with an empty
database (then run `npm run db:schema:local` and add test data through the app).

## 2. Start a dev session
1. `cd frontend && npm run build` (the Worker serves `frontend/out`).
2. `cd backend && npm run db:schema:local` (adds any tables new on this branch; it only
   creates what's missing, so existing data stays), then `npm run dev`: `wrangler dev` on
   http://localhost:8787 using the local database.
3. Optional hot reload for UI-only work: in `frontend/`, `npm run dev` (http://localhost:3000).
   It has no backend, so only guest mode works there; test login on :8787.

## Local data
The local DB is yours to test with: add, edit, or delete anything. Only the owner's
`npm run db:pull` resets it. Local queries:
`npx wrangler d1 execute recipes-db --local --command="SELECT ..."`.

## Report
In the PR's "How to test", say whether the local DB had data or was empty, which commands
you ran, and what you checked in the browser. Never report unrun checks as done.

## PR previews share the production database
Workers Builds runs `wrangler preview` for PR branches, and previews use the same D1
binding, i.e. **production**. The owner accepts this: it's a personal project, nobody
else gets the preview links, so nobody uses a preview to read or edit data. A separate
preview database may come later. It matters only if a PR would change production data
during the build or deploy itself (a build step, deploy script or startup code that writes
to the database without anyone using the preview). Flag that in the PR if your change does it.
