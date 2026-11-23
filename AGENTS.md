# AGENTS.md

Rules and context for every coding agent (Claude Code, Codex, ...) and human working in
this repo. This is the single source of truth: Codex and other agents read it directly,
and `CLAUDE.md` only contains `@AGENTS.md`, which makes Claude Code load this file. Read
it before changing anything, and keep it current: if you change the stack, commands,
layout, or conventions, update it in the same PR. Never add rules to `CLAUDE.md`.

## Known bugs and accepted trade-offs

There is no issue tracker, so these lists are how the next agent learns about them. Never
"fix" an accepted trade-off without asking the owner. **Before changing a feature, read
its area's Known gaps**:

- Imports (links, photos, models, quota, Facebook/Instagram, web pages):
  `backend/IMPORT.md` → Known gaps and accepted trade-offs.
- Pictures: `backend/README.md` → Pictures → Known gaps and accepted trade-offs.
- Screens: `frontend/README.md` → Known gaps and accepted trade-offs.

Add a line in the same PR when you find a bug you don't fix or the owner accepts a
trade-off, and remove it when it's resolved: here when it crosses areas, otherwise in its
area's list. One short line each, linking to the section with the details.

- PR previews share the production database and the production import Workflow
  (`backend/README.md` → Database; `backend/IMPORT.md` → Limits to keep in mind). Accepted.
- Production keeps an empty `folders` table and an always-NULL `recipes.folder_id` from
  before tags; dropping them needs a rebuild of recipes (`backend/README.md` → Database). Accepted.
- Builds made on Windows log harmless prefetch 404s (`frontend/README.md` → Layout). Accepted.
- No login rate limit, and a password may be 1 character (`backend/README.md` → Auth API). Accepted.
- Nothing records which migrations production has applied, and there is no rollback step
  (`backend/README.md` → Database). Accepted.

## The product

**web-recipe** is a small personal web app for a handful of people to keep their recipes.
All of this is built, except what says *may come later*. Each line is the decision; the
linked section has the details.

- **Users**: up to 50, each with their own data; nobody can change another user's. Anyone
  can sign up (username + password) until 50 exist, and a login is remembered on the
  device until the user logs out (`backend/README.md` → Users and login).
- **Guest mode**: fully usable, but nothing reaches the database. Imports, the AI tools
  and Browse need an account, and the backend refuses them (`frontend/README.md` → Login flow).
- **Admin**: one, set in the database, never by sign-up. In "My account" they can log in
  as any other user with no password, until that device logs out (`backend/README.md` → Auth API).
- **Recipes** are stored in **both English and Hebrew**, are public or private, and are
  added manually or imported (`backend/README.md` → Tags and recipes API).
- **Tags**: Home filters by tag. Tags are added and removed on the recipe's own page,
  without opening the edit form; a tag no recipe has is deleted by itself; a tag can be renamed.
- **Deleting** moves a recipe to **Recently deleted** for 30 days, where its owner can
  restore it; a daily cron job then deletes it for good. A guest's delete is final.
- **Import from a link**: YouTube, Facebook (videos and reels), Instagram (reels, and
  photo posts by their caption), public posts only, and any other public **web page**
  with a recipe. It runs in the background (a Cloudflare Workflow), so it keeps going
  after the user leaves, and saves the recipe by itself with no tags. Other platforms
  (TikTok, ...) *may come later*: don't build for them until asked (`backend/IMPORT.md`).
- **Import from a photo**: one picture of a **written** recipe, read the same way, best
  model first. A photo of food with no recipe text gives no recipe: the model never
  guesses one. A resized copy becomes the recipe's picture; the original waits only in
  Gemini's free file store and is deleted when the import ends. Several photos at once,
  and sharing a picture into the app, *may come later* (`backend/IMPORT.md` → Import from a photo).
- **Share to the app** (Android, installed app): sharing a post or page starts the
  import at once and closes the app (`frontend/README.md` → Screens → Share).
- **Models**: users don't choose a model; an import tries a fixed list of free models in
  order. The one choice is the **best model**: up to 5 a day per user (the admin has no
  5), offered on "Scan the link again" and used first for every photo; when it can't be
  used, the request goes on with the usual models, with no question
  (`backend/IMPORT.md` → Video, models and failures).
- **AI tools**, in a box at the bottom of a recipe's page, all shown at once: substitute
  an ingredient (suggestions in a popup, never saved), translate into the other language,
  calculate calories and protein, and, for an imported recipe, scan its link again. The
  edit form has no AI tools (`backend/README.md` → Translation, Calories estimate,
  Ingredient substitutes).
- **Author and picture**: an import fills in the author only when its source names one;
  the model never guesses one (`backend/IMPORT.md` → Author). A picture comes from the
  import or the edit form, **never an AI-generated picture of the dish**
  (`backend/README.md` → Pictures).
- **Browse**: other users' public recipes in a random order, loading as the user
  scrolls; one tap saves an identical copy as the user's own (`backend/README.md` → Browse API).
- The UI must be **extremely simple**: few screens, big obvious buttons, no learning curve.

### What this project is not

- Not built to scale. A few users, a few hundred recipes. No caches, microservices, or
  multi-tenant design, and no queues beyond the one Cloudflare Workflow that runs imports
  (and one daily cron job).
- Not paid. Every service must have a **free tier** that covers this usage (hosting, DB,
  LLM). Never add anything that needs a credit card to work.

## How to work here

- **Stay on task.** Keep the product goal in mind, but change only what the current
  feature or bug fix needs. No drive-by refactors; note other issues in the PR instead.
- **Simple first.** Smallest working solution. No speculative abstractions, options,
  or dependencies. Working code beats clever code.
- **Breaking changes are allowed** when they're the more correct fix (e.g. renaming a
  table after a fix), never as a drive-by. The site being down for a few moments is
  fine. Tell the owner, in chat and in the PR, what they must do (e.g. run a migration
  on production) and when relative to merging, and what breaks and for how long.
- **Ask when unsure.** If a requirement is ambiguous, ask the owner instead of guessing.
- **Flag contradictions.** If a prompt seems to contradict an `.md` file (this file, a
  README, or a skill), stop and ask whoever gave the prompt which one is right: change
  the request, or update the doc.
- **Owner** = the human who owns the repo and approves PRs.
- **Owner-only actions**: running a migration or `schema.sql` on production, `npm run
  db:pull`, `wrangler login`, Worker secrets, merging PRs, and GitHub and Cloudflare
  settings. Write in the PR what the owner must run and when; never do it yourself.

## Tech stack

| Area      | Choice                                             | Notes                                              |
|-----------|----------------------------------------------------|----------------------------------------------------|
| Frontend  | Next.js (App Router), React, plain JavaScript, CSS Modules | Static export (`output: 'export'`), no TypeScript, no UI library |
| Backend   | Cloudflare Worker, plain JavaScript (ES modules)   | Workers runtime with **no `nodejs_compat`**: web APIs only, never `node:*` modules; no web framework |
| Database  | Cloudflare D1 (serverless SQLite)                  |                                                    |
| Background jobs | Cloudflare Workflows; one daily Cron Trigger | Workflows for imports; the cron purges recipes deleted 30 days ago; both free |
| Images    | Cloudflare Images binding (free plan)              | Resizes a link import's picture once, when it is saved; offline in `wrangler dev` and tests |
| LLM       | Gemini free tier; Groq free tier as a text-only fallback | Models and limits in `backend/wrangler.jsonc` (`backend/IMPORT.md` → Video, models and failures) |
| Auth      | Built in, stored in D1                             | Password hashed with PBKDF2 (WebCrypto); stays logged in |
| Testing   | Vitest                                             | Backend uses `@cloudflare/vitest-plugin`           |
| Lint      | ESLint                                             | Flat config in each app                            |
| Hosting   | Cloudflare Workers free plan, deployed from GitHub | Workers Builds deploys on every merge to `main`    |

Adding a framework, language, paid service, or major dependency needs the owner's approval.

## Architecture

```
Browser
   │
   ▼
One Cloudflare Worker  (backend/)
├── /api/*   → JSON API (login required) ──► D1 (users, tags, recipes, pictures, imports)
│                                        ├──► Gemini file store (an uploaded photo, until its import ends)
│                                        └──► Workflow (import, in the background: the source's
│                                             site, Gemini, Groq, the Images binding; backend/IMPORT.md)
└── /*       → static files built from frontend/ (frontend/out)
```

- **One deployable, one origin.** The Worker serves the API and the frontend's static
  build, so there is no CORS or cross-domain auth in production.
- **Frontend and backend are separate projects.** Each has its own `package.json`,
  config, and README. They share no code; they talk only over the HTTP API. The backend
  only references the frontend's *build output* folder.
- **Secrets**: `backend/.dev.vars` locally (names in `backend/.dev.vars.example`), Worker
  secrets in production (`backend/README.md` → Secrets).

## Where code lives

```
.
├── backend/              # Cloudflare Worker (README.md: data, API, auth; IMPORT.md: the import)
│   ├── src/index.js      # Router, login check, the daily cron job
│   ├── src/import/       # The import Workflow, models, and one adapter per source
│   ├── schema.sql        # Every table, the source of truth for a new database
│   └── migrations/       # One-off changes to existing tables, run by the owner
├── frontend/             # Next.js app (static export)
│   ├── app/              # The screens
│   ├── lib/api.js        # The only data layer: the backend, or memory for a guest
│   └── lib/i18n.js       # Every UI string, in English and Hebrew
├── .agents/skills/       # Shared agent skills (source of truth)
├── .claude/              # Claude Code settings and hooks; skills is a symlink to ../.agents/skills
├── .worktreeinclude      # Git-ignored files copied into new agent worktrees (no secrets in it)
├── AGENTS.md             # This file: rules for every agent
└── CLAUDE.md             # Just `@AGENTS.md`, so Claude Code loads this file
```

The full file lists are in `backend/README.md` → Overview and `frontend/README.md` → Layout.

**Schema changes.** `backend/schema.sql` is the source of truth for a new database and
only creates what is missing. A change to an existing table also needs a one-off file in
`backend/migrations/`, which the owner runs on production; the PR says whether before or
after the merge. Nothing records which migrations have been applied (`backend/README.md` → Database).

## Commands

Run each from its own folder. Local dev never touches production (`local-dev` skill).

| Task           | `backend/`                                   | `frontend/`       |
|----------------|----------------------------------------------|-------------------|
| Install        | `npm ci`                                     | `npm ci`          |
| Dev server     | `npx wrangler dev --port <8788-8799>`, serving `frontend/out` (build the frontend first) | `npm run dev -- -p <3001-3009>` |
| Tests          | `npm test` (Workers runtime, throwaway local DB) | `npm test`        |
| Lint           | `npm run lint`                               | `npm run lint`    |
| Build          | n/a                                          | `npm run build` → `out/` |
| DB             | `npm run db:schema:local` (apply `schema.sql` locally); in a worktree, `npm run db:copy-main` (copy the main checkout's local DB) | n/a |
| Deploy         | only by the owner merging a PR into `main` (Workers Builds) | (deployed with backend) |

**No CI.** Nothing on GitHub runs lint or tests; `main` only requires a PR (no direct
push, force-push or deletion). Your local checks are the only gate.

## Never do these

- Push or commit directly to `main`, force-push a shared branch, or merge a PR
  (`gh pr merge` included): only the owner merges.
- Commit secrets, or read/print `.env` or `.dev.vars`. Commit `.dev.vars.example` /
  `.env.example` with placeholder values instead.
- Import code across `backend/` and `frontend/`.
- Call the LLM from the frontend. API keys exist only in the Worker.
- Call a model (Gemini, Groq) without the owner's OK in the chat: a real import, AI tool or
  script run locally spends real quota (`local-dev`). Reading any link's page locally, with
  no model call, needs no OK.
- Add an API endpoint that skips the login check (only sign-up, login and logout are public).
- Start a server on :8787 or :3000: they're the owner's (`local-dev` → Ports).
- Run `npm run deploy`, `wrangler deploy`, `wrangler login`, `wrangler secret`, or any
  wrangler command with `--remote`. Run the app only locally.
- Add a paid service or anything outside the free tiers above.

## Conventions

- Clarity over cleverness: small functions, descriptive names, plain JavaScript.
- Comments explain *why*, not *what*. No commented-out code.
- Validate all input in the backend; never trust the client.
- Write tests with every feature and bug fix (a failing test first for bugs). Backend
  changes always get simple tests: a few clear cases per endpoint, run on the local DB.
- **Docs move with the code.** Every feature or bug fix updates the relevant `.md` files
  in the same PR whenever it changes what they describe: this file (product, stack,
  commands, rules), `backend/README.md` (schema, API, auth, env), `backend/IMPORT.md`
  (the import and its models), `frontend/README.md` (screens, UX), and skills. Remove
  docs that became wrong. **One fact, one file**: link to the section that holds a fact
  instead of restating it, so it never goes stale in a second place.
- Git: one task = one session = one **git worktree** on a branch from an up-to-date
  `origin/main`. Use Conventional Commits and PR into `main`. Full steps in the
  `git-workflow` skill.

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
    Code sees no skills. One-time fix per clone and per worktree, no admin needed (Git
    Bash, repo or worktree root):
    `rm .claude/skills && cmd //c "mklink /J .claude\skills .agents\skills" && git update-index --skip-worktree .claude/skills`
- **Worktrees**: one per session; if the session already runs in one, work there and
  never make a second. Setup and removal are in `git-workflow` → reference.md.
- **Claude Code settings**: `.claude/settings.json` (committed) denies a few `git push`
  spellings (`--force`, `-f`, `origin main`) and reading `.env` and `.dev.vars` (the Read
  tool, and any shell command naming `.dev.vars`). GitHub refuses pushes to `main` anyway.
  Its `SessionStart` hook (`.claude/hooks/install-deps.mjs`) installs missing
  `node_modules` in a new worktree. Personal overrides go in `.claude/settings.local.json`
  (git-ignored).
- Don't commit plans, scratch files, or debug output. Unfixed bugs and trade-offs
  go in [Known bugs and accepted trade-offs](#known-bugs-and-accepted-trade-offs).
