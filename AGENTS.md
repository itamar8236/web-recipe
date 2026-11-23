# AGENTS.md

Rules and context for every coding agent (Claude Code, Codex, ...) and human in this repo,
and the single source of truth: `CLAUDE.md` only contains `@AGENTS.md`, so never add rules
there.

## Known bugs and accepted trade-offs

There is no issue tracker, so each area's docs list its known bugs and the trade-offs the
owner accepted. **Read them before changing that area, and never "fix" an accepted one
without asking the owner**:

- Imports (links, photos, models, quota, sites): `backend/IMPORT.md` → Known gaps and
  accepted trade-offs.
- Pictures: `backend/README.md` → Pictures → Known gaps and accepted trade-offs.
- Database, previews and login: `backend/README.md` → Database and Auth API.
- Screens and builds: `frontend/README.md` → Known gaps and accepted trade-offs.

Add a line to that list in the same PR when you find a bug you don't fix or the owner
accepts a trade-off, and remove it when it's resolved.

## The product

**web-recipe** is a small personal web app for a handful of people to keep their recipes.
All of this is built, except what says *may come later*; the linked sections have details.

- **Users**: up to 50, each with their own data; nobody can change another user's. Anyone
  can sign up (username + password) until 50 exist, and a login is remembered on the
  device until the user logs out (`backend/README.md` → Users and login).
- **Guest mode**: fully usable, but nothing reaches the database. Imports, the AI tools
  and Browse need an account, and the backend refuses them (`frontend/README.md` → Login flow).
- **Admin**: one, set in the database, never by sign-up. In "My account" they can log in
  as any other user with no password, until that device logs out (`backend/README.md` → Auth API).
- **Recipes** are stored in **both English and Hebrew**, are public or private, and are
  added manually or imported (`backend/README.md` → Tags and recipes API).
- **Tags**: Home filters by tag; tags are added and removed on the recipe's own page,
  without opening the edit form.
- **Deleting** moves a recipe to **Recently deleted**, where its owner can restore it
  for 30 days. A guest's delete is final.
- **Import from a link**: YouTube, Facebook (videos and reels), Instagram (reels, and
  photo posts by their caption), public posts only, and any other public **web page**.
  It runs in the background and saves the recipe by itself, with no tags. Other platforms
  (TikTok, ...) *may come later*: don't build for them until asked (`backend/IMPORT.md`).
- **Import from a photo**: one picture of a **written** recipe; a photo of food with no
  recipe text gives no recipe, since the model never guesses one. The original is deleted
  when the import ends. Several photos at once, and sharing a picture into the app, *may come later*
  (`backend/IMPORT.md` → Import from a photo).
- **Share to the app** (Android, installed app): sharing a post or page starts the
  import at once and closes the app (`frontend/README.md` → Screens → Share).
- **Models**: users don't choose one; an import tries a fixed list of free models. The one
  choice is the **best model**: 5 a day per user (the admin has no 5), on "Scan the link
  again" and first for every photo; when it can't be used, the usual models go on with no
  question (`backend/IMPORT.md` → Video, models and failures).
- **AI tools**, all in one box on a recipe's page, never in the edit form: substitute an
  ingredient (never saved), translate, calculate calories and protein, and scan the link
  again (`backend/README.md` → Translation, Calories estimate, Ingredient substitutes).
- **Author and picture**: the model never guesses an author (`backend/IMPORT.md` →
  Author), and a picture is **never an AI-generated picture of the dish** (`backend/README.md` → Pictures).
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
  table after a fix), never as a drive-by; a few moments of downtime is fine. Say in chat
  and in the PR what breaks and what the owner must do when (`git-workflow` → Push and open a PR).
- **Ask when unsure.** If a requirement is ambiguous, ask the owner instead of guessing.
- **Flag contradictions.** If a prompt seems to contradict an `.md` file (this file, a
  README, or a skill), stop and ask whoever gave the prompt which one is right: change
  the request, or update the doc.
- **Owner-only actions**: running a migration or `schema.sql` on production, `npm run
  db:pull`, `wrangler login`, Worker secrets, merging PRs, and GitHub and Cloudflare
  settings. Write in the PR what the owner must run and when; never do it yourself.

## Tech stack

| Area      | Choice                                             | Notes                                              |
|-----------|----------------------------------------------------|----------------------------------------------------|
| Frontend  | Next.js (App Router), React, plain JavaScript, CSS Modules | Static export (`output: 'export'`), no TypeScript, no UI library |
| Backend   | Cloudflare Worker, plain JavaScript (ES modules)   | Workers runtime with **no `nodejs_compat`**: web APIs only, never `node:*` modules; no web framework |
| Database  | Cloudflare D1 (serverless SQLite)                  |                                                    |
| Background jobs | Cloudflare Workflows; one daily Cron Trigger | Workflows for imports; the cron purges deleted recipes; both free |
| Images    | Cloudflare Images binding (free plan)              | Resizes a link import's picture (`backend/README.md` → Pictures) |
| LLM       | Gemini free tier; Groq free tier as a text-only fallback | Models and limits in `backend/wrangler.jsonc` (`backend/IMPORT.md` → Video, models and failures) |
| Auth      | Built in, stored in D1                             | PBKDF2 (WebCrypto)                                 |
| Hosting   | Cloudflare Workers free plan, deployed from GitHub | Workers Builds deploys on every merge to `main`    |

Adding a framework, language, paid service, or major dependency needs the owner's approval.

## Architecture and where code lives

- **One deployable, one origin.** The Worker serves the API and the frontend's static
  build, so there is no CORS or cross-domain auth in production.
- **Frontend and backend are separate projects**, each with its own `package.json` and
  README, sharing no code and talking only over the HTTP API (the backend serves `frontend/out`).

The request flow and the full file lists are in `backend/README.md` → Overview and
`frontend/README.md` → Layout.

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
└── .claude/              # Claude Code settings and hooks (Agent setup below)
```

**Schema changes**: a change to an existing table needs, besides `schema.sql`, a one-off
file in `backend/migrations/` that the owner runs; the PR says whether before or after
the merge (`backend/README.md` → Database).

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

**No CI.** Nothing on GitHub runs lint or tests; `main` only requires a PR (no direct
push, force-push or deletion). Your local checks are the only gate.

## Never do these

- Push or commit directly to `main`, force-push a shared branch, or merge a PR
  (`gh pr merge` included): only the owner merges.
- Commit secrets, or read/print `.env` or `.dev.vars`. Commit `.dev.vars.example` /
  `.env.example` with placeholder values instead.
- Import code across `backend/` and `frontend/`.
- Call the LLM from the frontend. API keys exist only in the Worker (`backend/README.md` → Secrets).
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
- **Docs move with the code.** Every feature or bug fix updates, in the same PR, every
  `.md` file whose content it changes (this file, the READMEs, `backend/IMPORT.md`,
  skills), and removes docs that became wrong. **One fact, one file**: link to the section
  that holds a fact instead of restating it, so it never goes stale in a second place.
- Git: one task = one session = one **git worktree** (if the session already runs in
  one, never make a second) on a branch from an up-to-date `origin/main`. Use
  Conventional Commits and PR into `main`. Full steps in the `git-workflow` skill.

## Verifying before every push

- Run lint and tests for each app you touched. Prefer focused tests.
- UI changes: run the app and check it in a browser at phone (~360px) and desktop widths,
  in both English and Hebrew.
- Never report work as done if checks failed or weren't run; say exactly what was
  and wasn't verified.

## Agent setup

- **Skills** live only in `.agents/skills/` (read by all agents); `.claude/skills` is a git
  symlink to it for Claude Code. Edit and commit only `.agents/skills/`.
  - On Windows without symlinks the link is a small text file and Claude Code sees no
    skills. One-time fix per clone and worktree, from its root in Git Bash:
    `rm .claude/skills && cmd //c "mklink /J .claude\skills .agents\skills" && git update-index --skip-worktree .claude/skills`
- **Claude Code settings**: `.claude/settings.json` denies a few `git push` spellings and
  reading `.env` / `.dev.vars`, and its `SessionStart` hook installs missing
  `node_modules`. Personal overrides go in `.claude/settings.local.json` (git-ignored).
- Don't commit plans, scratch files, or debug output.
