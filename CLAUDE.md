# CLAUDE.md

Rules and context for every coding agent (Claude Code, Codex, ...) and human working in
this repo. `AGENTS.md` points here. Read this file before changing anything, and keep
it current: if you change the stack, commands, layout, or conventions, update it in the
same PR.

## Status

Built so far: the recipe browsing UI (folders, recipes, English/Hebrew, manual add/edit/
delete), keeping data in memory and starting empty, and the D1 binding + schema (`backend/schema.sql`). Login,
the API, and LLM import are not built yet; the sections below describe the target.

## The product

**web-recipe** is a small personal web app for a handful of people to keep their recipes.

- Recipes live in **folders** (a flat list) the user creates, renames, and deletes.
- Add, edit, and delete recipes **manually**, or **from a short-video link**: the
  backend sends the link to Google's free LLMs, which extract the recipe, and the user
  saves it. Supported now: **YouTube and Facebook** only. Other platforms may come later;
  don't build for them until asked.
- When several LLM models are configured, an import runs all of them and the user
  **compares the results side by side** and picks one to save.
- Every recipe shows its **name, source link, ingredients, and instructions in both
  English and Hebrew** (Hebrew renders right-to-left).
- **Up to 50 users**, each with their **own private folders, recipes, and favorites**
  (nothing is shared between users). One **admin** (the owner) adds users, sets their
  first password, can **act as any user** to see and manage their data, and deletes
  users (which deletes all of their data). Login is **username plus a
  password**, and the session is remembered: after logging in once, a user never sees
  the login page again on that device unless they log out, change their password, or the
  admin deletes them.
- The UI must be **extremely simple**: few screens, big obvious buttons, no learning curve.

### What this project is not

- Not built to scale. A few users, a few hundred recipes. No queues, caches, microservices,
  or multi-tenant design.
- Not paid. Every service must have a **free tier** that covers this usage (hosting, DB,
  LLM). Never add anything that needs a credit card to work.

## How to work here

- **Stay on task.** Keep the product goal in mind, but change only what the current
  feature or bug fix needs. No drive-by refactors; note other issues in the PR instead.
- **Simple first.** Smallest working solution. No speculative abstractions, options,
  or dependencies. Working code beats clever code.
- **Ask when unsure.** If a requirement is ambiguous, ask the owner instead of guessing.
- **Flag contradictions.** If a prompt seems to contradict an `.md` file (this file, a
  README, or a skill), stop and ask whoever gave the prompt which one is right: change
  the request, or update the doc.
- **Owner** = the human who owns the repo and approves PRs.

## Tech stack

| Area      | Choice                                             | Notes                                              |
|-----------|----------------------------------------------------|----------------------------------------------------|
| Frontend  | Next.js (App Router), React, plain JavaScript, CSS Modules | Static export (`output: 'export'`), no TypeScript, no UI library |
| Backend   | Cloudflare Worker, plain JavaScript (ES modules)   | Node-style JS on the Workers runtime (`nodejs_compat`); no web framework |
| Database  | Cloudflare D1 (serverless SQLite)                  |                                                    |
| LLM       | Google's free-tier LLMs                            | One or more models, set by config; key in a Worker secret |
| Auth      | Built in, stored in D1                             | Password hashed with PBKDF2 (WebCrypto); admin manages users; stays logged in |
| Testing   | Vitest                                             | Backend uses `@cloudflare/vitest-pool-workers`     |
| Hosting   | Cloudflare Workers free plan, deployed from GitHub | Workers Builds deploys on every merge to `main`    |

Adding a framework, language, paid service, or major dependency needs the owner's approval.

## Architecture

```
Browser
   │
   ▼
One Cloudflare Worker  (backend/)
├── /api/*   → JSON API (login required) ──► D1 (users, folders, recipes)
│                                        └──► Google LLMs (video → recipe, translation)
└── /*       → static files built from frontend/ (frontend/out)
```

- **One deployable, one origin.** The Worker serves the API and the frontend's static
  build, so there is no CORS or cross-domain auth in production.
- **Frontend and backend are separate projects.** Each has its own `package.json`,
  config, and README. They share no code; they talk only over the HTTP API. The backend
  only references the frontend's *build output* folder.
- **Details live next to the code:**
  - [`backend/README.md`](backend/README.md): data model, auth, API contract, LLM import
    flow, secrets, deploy.
  - [`frontend/README.md`](frontend/README.md): screens, UX rules, bilingual/RTL, API client.

## Where code lives

```
.
├── backend/          # Cloudflare Worker: API, D1 access, LLM calls, serves frontend build
├── frontend/         # Next.js app (static export)
├── .agents/skills/   # Shared agent skills (source of truth)
├── .claude/          # Claude Code settings; skills is a symlink to ../.agents/skills
├── AGENTS.md         # Entry point for non-Claude agents, points here
└── CLAUDE.md         # This file
```

## Commands

Run each from its own folder. The backend is assets-only for now (no Worker code, tests,
or lint yet), so those rows are planned until it gets real code. The D1 database is
bound and has a schema; local dev never touches production (`local-dev` skill).

| Task           | `backend/`                                   | `frontend/`       |
|----------------|----------------------------------------------|-------------------|
| Install        | `npm install`                                | `npm install`     |
| Dev server     | `npm run dev` (wrangler on :8787 with the local DB, serving `frontend/out`: build the frontend first) | `npm run dev` (:3000) |
| Tests          | (planned)                                    | `npm test`        |
| Lint           | (planned)                                    | `npm run lint`    |
| Build          | n/a                                          | `npm run build` → `out/` |
| DB             | `npm run db:schema:local` (apply `schema.sql` locally). Owner only, wrangler is otherwise logged out: `npx wrangler login`, `npm run db:pull` (prod → local), `npx wrangler logout`; production schema is applied by the owner | n/a |
| Deploy         | automatic on merge to `main` (or `npm run deploy`) | (deployed with backend) |

## Never do these

- Push or commit directly to `main`, force-push a shared branch, or merge your own PR.
- Commit secrets, or read/print `.env` or `.dev.vars`. Commit `.dev.vars.example` /
  `.env.example` with placeholder values instead.
- Import code across `backend/` and `frontend/`.
- Call the LLM from the frontend. API keys exist only in the Worker.
- Add an API endpoint that skips the login check (only login itself is public), or an
  admin action that skips the admin check.
- Add a paid service or anything outside the free tiers above.

## Conventions

- Clarity over cleverness: small functions, descriptive names, plain JavaScript.
- Comments explain *why*, not *what*. No commented-out code.
- Validate all input in the backend; never trust the client.
- Write tests with every feature and bug fix (a failing test first for bugs).
- **Docs move with the code.** Every feature or bug fix updates the relevant `.md` files
  in the same PR whenever it changes what they describe: this file (product, stack,
  commands, rules), `backend/README.md` (schema, API, auth, LLM flow, env),
  `frontend/README.md` (screens, UX), and skills. Remove docs that became wrong.
- Git: always `git checkout main && git pull` before creating a new branch, use
  Conventional Commits, and PR into `main`. Full steps in the `git-workflow` skill.

## Verifying

Before every push:

- Run lint and tests for each app you touched. Prefer focused tests.
- UI changes: run the app and check it in a browser at phone (~360px) and desktop widths,
  in both English and Hebrew.
- Never report work as done if checks failed or weren't run; say exactly what was
  and wasn't verified.

## Agent setup

- **Skills** live only in `.agents/skills/` (read by all agents). `.claude/skills` is a
  git symlink to `../.agents/skills` so Claude Code finds the same files; there is no
  copy to keep in sync. Edit and commit only `.agents/skills/`.
  - Windows without symlink support checks the link out as a small text file, so Claude
    Code sees no skills. One-time fix per clone, no admin needed (Git Bash, repo root):
    `rm .claude/skills && cmd //c "mklink /J .claude\skills .agents\skills" && git update-index --skip-worktree .claude/skills`
  - `git-workflow`: branch, commit, push, open a PR
  - `new-feature`: feature checklist across backend and frontend
  - `bug-fix`: reproduce, test, fix, verify
  - `frontend-ui`: UI work in `frontend/`
  - `local-dev`: run and test the app against a local copy of the DB, never production
- **Claude Code settings**: `.claude/settings.json` (committed) blocks force-pushes,
  pushes to `main`, and reading secret files. Personal overrides go in
  `.claude/settings.local.json` (git-ignored).
- Don't commit plans, scratch files, or debug output. Track work in GitHub issues and PRs.
