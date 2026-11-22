---
name: local-dev
description: How to run, test, and verify web-recipe locally against the local copy of the D1 database, never production. Use whenever running the app or dev servers, testing or verifying a change, or touching the database (schema, queries, seed data, wrangler d1 commands).
---

# Running and testing web-recipe locally

Always work against the **local** D1 database (`backend/.wrangler/state`). It's a copy
of production that the owner refreshes in the main checkout. Each git worktree has its
own copy, so a new worktree starts empty until it copies the main checkout's (step 1 below). Production (`recipes-db` on Cloudflare) holds
real users' recipes; only the owner reads or changes it.

Assume wrangler is **logged out**: the owner logs in only for a moment to refresh the
local copy, so agents can't reach production even by accident.

## Hard rules
- Never pass `--remote` to any wrangler command, and never run `npm run db:pull`
  (it reads production; it's the owner's command).
- Never run `npx wrangler login` or handle Cloudflare credentials. If wrangler happens to
  be logged in, don't use it for anything remote.
- Never add `"remote": true` to `backend/wrangler.jsonc`.
- Never run `wrangler deploy` / `npm run deploy`. Run the app only with `npm run dev`;
  production is deployed only when the owner merges a PR into `main`.
- Production schema or data changes are the owner's job. If one is needed, write it in
  the PR with when to run it relative to merging (e.g. "run `npx wrangler d1 execute recipes-db --remote --file=schema.sql`").
- `backend/.wrangler/prod-dump.sql` and the local database contain real user data: never
  commit them (`.wrangler/` is gitignored), copy them elsewhere, or paste their contents in
  PRs, issues, or chat. The one allowed copy is `npm run db:copy-main` (step 1), which
  copies the main checkout's local database into a worktree on the same computer.
- Never read `backend/.dev.vars` or `.env`. `.dev.vars` holds the owner's dev keys, which
  use a test quota, not production's.
- You may test on the local app with any link, including the ones in the local
  database's recipes. Fetching a page yourself (no model) needs no OK, e.g. to see where a
  site keeps a field. **Every call to a model needs the owner's OK in the chat first**: a
  real import, an AI tool, or a script that reaches Gemini or Groq. Ask with the links and
  how many calls, and wait. Don't tick "Use the best model" (or send `model: 'best'`) unless
  the owner asks, so testing doesn't use up its 20 requests a day. A photo import always
  calls the best model first; use only pictures the owner gave in the chat (never commit
  them or copy them into the repo). Automated tests always use fake keys and stubs. List in
  the PR the real imports you ran. `node scripts/e2e-links.mjs "<link>" ...` (from
  `backend/`, with the app running) runs links, or a file of them, through the local app on
  a test account, without the best model by default; it's the check after Facebook or
  Instagram change their pages.

## 1. Check the local copy
From `backend/`:
```
npx wrangler d1 execute recipes-db --local --command="SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM recipes) AS recipes"
```
If it fails with `no such table`, or every count is 0, the local copy is empty. In a
worktree, run `npm run db:copy-main` (from `backend/`): it replaces this worktree's local
database with a copy of the main checkout's one, then applies `schema.sql`. It changes
nothing in the main checkout. The copy is as fresh as the owner's last `db:pull`; run it
again to pick up a newer one (it discards this worktree's local test data).

If it says the main checkout has no local database, or the counts are still 0, stop and
tell the owner, giving them these commands to run themselves from `backend/` in the main
checkout:
```
npx wrangler login
npm run db:pull
npx wrangler logout
```
Then run `npm run db:copy-main` again. Continue only when they say it's done, or if they tell you to go on with an empty
database (then run `npm run db:schema:local` and add test data through the app).

## 2. Start a dev session
0. If `backend/node_modules` or `frontend/node_modules` is missing (a new worktree whose
   setup hook didn't run), run `npm ci` in that folder first. Tests need it too.
1. `cd frontend && npm run build` (the Worker serves `frontend/out`).
2. Pick a free port (see **Ports** below), then `cd backend && npm run db:schema:local`
   (adds any tables new on this branch; it only creates what's missing, so existing data
   stays), then `npx wrangler dev --port <port>`: `wrangler dev` on
   http://localhost:<port> using the local database. Not `npm run dev`: it is pinned to
   the owner's :8787.
3. Optional hot reload for UI-only work: in `frontend/`, `npm run dev -- -p <port>` from the
   frontend range. It has no backend, so only guest mode works there; test login on the
   Worker.
4. **Always stop every server you started when you're done testing**, before reporting
   or ending your turn, also when the testing failed, so the next agent finds the port free
   and nothing keeps showing your worktree's code. Check that nothing you started is
   still listening.

### Ports
**:8787 and :3000 are the owner's**: they test PRs there. Agents never start a server on
them, even when they look free. Several agents may run at once, so each takes the first
free port in its range:

| Server | Agents use |
|---|---|
| Worker (`wrangler dev`) | 8788-8799 |
| `next dev` | 3001-3009 |

- Check before starting: `netstat -ano | grep -E ":<port> .*LISTEN"` (Git Bash) must print
  nothing. On Windows a second server can bind a port that is already taken without any
  error, and the browser then reaches whichever one it likes, so never rely on the start
  failing.
- `wrangler dev` also opens an inspector port (9229 and up); it picks a free one by itself.
- Claude desktop app: `preview_start` runs entries from `.claude/launch.json`, which is
  git-excluded (each checkout has its own). Add an entry for your port there, e.g.
  `{"name": "backend-8790", "runtimeExecutable": "npx", "runtimeArgs": ["--prefix",
  "backend", "wrangler", "dev", "--cwd", "backend", "--port", "8790"], "port": 8790}`,
  and never start the `backend` / `frontend` entries, which use the owner's ports.
- A server on one of the owner's ports that you didn't start belongs to them or to
  another session: leave it alone and tell the owner if it is in the way.

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
