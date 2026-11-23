---
name: local-dev
description: How to run, test, and verify web-recipe locally against the local copy of the D1 database, never production. Use whenever running the app or dev servers, testing or verifying a change, or touching the database (schema, queries, seed data, wrangler d1 commands).
---

# Running and testing web-recipe locally

Always work against the **local** D1 database (`backend/.wrangler/state`). It's a copy
of production that the owner refreshes in the main checkout. Each git worktree has its
own copy, so a new worktree starts empty until it copies the main checkout's (step 1).
Production (`recipes-db` on Cloudflare) holds real users' recipes; only the owner reads
or changes it. Details (ports, the Claude desktop app, local data, PR previews) are in
[`reference.md`](reference.md).

Assume wrangler is **logged out**: the owner logs in only for a moment to refresh the
local copy, so agents can't reach production even by accident.

## Hard rules
- Never pass `--remote` to any wrangler command, never run `npm run db:pull`, and never
  run `npx wrangler login` or handle Cloudflare credentials. Never add `"remote": true`
  to `backend/wrangler.jsonc`. If wrangler happens to be logged in, use it for nothing remote.
- Never deploy (`AGENTS.md` → Never do these). Run the app only locally, with
  `npx wrangler dev --port <8788-8799>`; never `npm run dev`, which is pinned to the
  owner's :8787.
- Production schema or data changes are the owner's job. If one is needed, write it in
  the PR with when to run it relative to merging (e.g. "run `npx wrangler d1 execute recipes-db --remote --file=schema.sql`").
- `backend/.wrangler/prod-dump.sql` and the local database contain real user data: never
  commit them, copy them elsewhere, or paste their contents in PRs or chat. The one
  allowed copy is `npm run db:copy-main` (step 1).
- Never read `backend/.dev.vars` or `.env`.
- **Every call to a model needs the owner's OK in the chat first**: a real import, an AI
  tool, or a script that reaches Gemini or Groq. Ask with the links and how many calls,
  and wait. Fetching a page yourself (no model) needs no OK. Don't tick "Use the best
  model" (or send `model: 'best'`) unless the owner asks: it has 20 requests a day. A
  photo import always calls the best model first; use only pictures the owner gave in the
  chat, and never commit them. List in the PR the real imports you ran.
  `node scripts/e2e-links.mjs "<link>" ...` (from `backend/`, with the app running) runs
  links through the local app on a test account; it's the check after Facebook or
  Instagram change their pages. Automated tests always use fake keys and stubs.

## 1. Check the local copy
From `backend/`:
```
npx wrangler d1 execute recipes-db --local --command="SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM recipes) AS recipes"
```
If it fails with `no such table`, or every count is 0, the local copy is empty. In a
worktree, run `npm run db:copy-main` (from `backend/`): it replaces this worktree's local
database with a copy of the main checkout's one, then applies `schema.sql`, and changes
nothing in the main checkout. Run it again to pick up a newer copy (it discards this
worktree's local test data).

If the main checkout has no local database, or the counts are still 0, stop and ask the
owner to refresh it (`backend/README.md` → Database → Refreshing the local copy), then run
`npm run db:copy-main` again. Continue only when they say it's done, or if they tell you
to go on with an empty database (then `npm run db:schema:local` and add test data
through the app).

## 2. Start a dev session
0. If `backend/node_modules` or `frontend/node_modules` is missing, run `npm ci` there.
1. `cd frontend && npm run build` (the Worker serves `frontend/out`).
2. Pick a free port (`reference.md` → Ports), then `cd backend && npm run db:schema:local`
   (adds any tables new on this branch; existing data stays), then
   `npx wrangler dev --port <port>`.
3. Optional hot reload for UI-only work: in `frontend/`, `npm run dev -- -p <3001-3009>`.
   It has no backend, so only guest mode works there; test login on the Worker.
4. **Always stop every server you started when you're done testing**, before reporting
   or ending your turn, also when the testing failed. Check that nothing you started is
   still listening.

## Report
In the PR's "How to test", say whether the local DB had data or was empty, which commands
you ran, and what you checked in the browser. Never report unrun checks as done.
