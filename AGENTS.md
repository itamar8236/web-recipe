# AGENTS.md

Rules and context for every coding agent (Claude Code, Codex, ...) and human working in
this repo. This is the single source of truth: Codex and other agents read it directly,
and `CLAUDE.md` only contains `@AGENTS.md`, which makes Claude Code load this file. Read
it before changing anything, and keep it current: if you change the stack, commands,
layout, or conventions, update it in the same PR. Never add rules to `CLAUDE.md`.

## Status

Built so far: the recipe browsing UI (folders, recipes, favorites, English/Hebrew, manual
add/edit/delete), the D1 binding + schema (`backend/schema.sql`), sign-up / log-in /
log-out with remembered sessions plus a guest mode, editing your own username and
password, the folders/recipes API, so a
logged-in user's data is stored in D1 (a guest's stays in browser memory), and creating
a recipe from a YouTube, Facebook or Instagram link in the background with a Cloudflare
Workflow, plus two AI tools on the edit form (translate a recipe, scan its video again). The sections
below describe the target; the READMEs' "Current state" sections say what exists.

## Known bugs and accepted trade-offs

There is no issue tracker, so this list is how the next agent learns about them. Don't
"fix" an accepted trade-off without asking the owner. Add a line in the same PR when you
find a bug you don't fix or the owner accepts a trade-off, and remove it when it's
resolved. One short line each, linking to the README section with the details.

- PR previews share the production database (`backend/README.md` → Database). Accepted.
- Builds made on Windows log harmless prefetch 404s (`frontend/README.md` → Layout).
  Accepted.
- PR previews can't exercise the import Workflow: they use the one already deployed to
  production (`backend/README.md` → Import from a YouTube link). Accepted.
- The free-tier model quota is shared by all users: 20 requests a day on each stronger
  model, 500 on the small one (`backend/README.md` → Import from a YouTube link). Accepted.
- A few rare import edge cases are left as they are (`backend/README.md` → Import from a
  YouTube link → Known small gaps).
- Facebook and Instagram are read as an anonymous visitor, so only public posts work, and
  Meta may block or change this at any time (`backend/README.md` → Facebook and Instagram).
  Not yet checked from Cloudflare's network. Facebook photo and text posts aren't supported.
- `ConfirmDialog` opens with focus on its confirm button, not Cancel (`frontend/README.md` →
  UX rules).

## The product

**web-recipe** is a small personal web app for a handful of people to keep their recipes.

- Recipes live in **folders** (a flat list) the user creates, renames, and deletes.
- Add, edit, and delete recipes **manually**, or **from a link**: the backend sends the
  post's text and video to Google's free LLMs in the background, so it keeps going after
  the user leaves the app, and **saves the recipe by itself**, with no folder. The user can
  edit or delete it afterwards. Supported now: **YouTube**, **Facebook** (videos and reels)
  and **Instagram** (reels, and photo posts by their caption), public posts only. Only
  short videos are sent to the LLM (a longer one still works when its text holds the
  recipe); if a video can't be fetched, the text alone is used. Other platforms (TikTok,
  ...) may come later; don't build for them until asked.
- **Users don't choose a model.** An import tries a fixed list of free models in order
  and moves on at once from one that is busy or out for the day; a request with no video
  (a translation, a caption-only import) ends on a **fallback** text model from another
  free provider, if its key is set. A translation goes to the small model first. Which
  model wrote a recipe is stored with it.
- The one choice is the **best model**: slower and more detailed, up to 5 a day per user,
  offered only on "Scan the video again". Every try that calls it counts toward the 5.
  When it can't be used, the scan goes on with the usual models by itself, with no question.
- The **edit form** holds the AI tools: **translate** the language being written into the
  other one (any recipe, manual ones too; nothing is saved until Save), and, for an
  imported recipe, **scan its video again**, which runs like a new import and replaces
  the recipe's text.
- Every recipe shows its **name, source link, ingredients, and instructions in both
  English and Hebrew** (Hebrew renders right-to-left).
- **Up to 50 users**, each with their **own private folders, recipes, and favorites**
  (nothing is shared between users). Anyone can **sign up** with a username and password
  (until 50 users exist). One **admin** (the owner, created by hand on production) can
  **act as any user** to see and manage their data, and deletes users (which deletes all
  of their data). Login is **username plus a password**, and the session is remembered:
  after logging in once, a user never sees the login page again on that device unless they
  log out or the admin deletes them. Changing their own username or password keeps them
  logged in on every device.
- **Guest mode**: the login screen has "Continue as guest". The app is fully usable, but
  nothing is read from or written to the database; the guest starts empty and loses
  everything on reload. Importing from a link and the AI tools need an account.
- The UI must be **extremely simple**: few screens, big obvious buttons, no learning curve.

### What this project is not

- Not built to scale. A few users, a few hundred recipes. No caches, microservices, or
  multi-tenant design, and no queues beyond the one Cloudflare Workflow that runs imports.
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
| Background jobs | Cloudflare Workflows                         | Imports only; free on this plan                    |
| LLM       | Google's free-tier LLMs; Groq's free tier as a text-only fallback | An ordered list of import models, a translation model, a fallback and an opt-in best model, all set by config; keys in Worker secrets. Videos are handed to Gemini through its free file store |
| Auth      | Built in, stored in D1                             | Password hashed with PBKDF2 (WebCrypto); admin manages users; stays logged in |
| Testing   | Vitest                                             | Backend uses `@cloudflare/vitest-plugin`           |
| Hosting   | Cloudflare Workers free plan, deployed from GitHub | Workers Builds deploys on every merge to `main`    |

Adding a framework, language, paid service, or major dependency needs the owner's approval.

## Architecture

```
Browser
   │
   ▼
One Cloudflare Worker  (backend/)
├── /api/*   → JSON API (login required) ──► D1 (users, folders, recipes, imports)
│                                        └──► Workflow (import, in the background)
│                                               ├──► YouTube Data API (video details)
│                                               ├──► Facebook / Instagram (public post page, video file)
│                                               ├──► Google LLMs (text + video → recipe)
│                                               └──► Groq (text-only fallback)
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
├── AGENTS.md         # This file: rules for every agent
└── CLAUDE.md         # Just `@AGENTS.md`, so Claude Code loads this file
```

## Commands

Run each from its own folder. The backend has no lint yet (planned). The D1 database is
bound and has a schema; local dev never touches production (`local-dev` skill).

| Task           | `backend/`                                   | `frontend/`       |
|----------------|----------------------------------------------|-------------------|
| Install        | `npm install`                                | `npm install`     |
| Dev server     | `npm run dev` (wrangler on :8787 with the local DB, serving `frontend/out`: build the frontend first) | `npm run dev` (:3000) |
| Tests          | `npm test` (Workers runtime, throwaway local DB) | `npm test`        |
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
- Run a real video import on a link the owner didn't give in the chat (`local-dev`).
- Fetch a pasted link as it is, or follow a redirect automatically. The Worker fetches
  only URLs it builds from a parsed id, on the site's own hosts, checking every hop
  (`backend/README.md` → Links). No proxies, scraping services, logins or CAPTCHA solvers.
- Add an API endpoint that skips the login check (only sign-up, login and logout are public), or an
  admin action that skips the admin check.
- Add a paid service or anything outside the free tiers above.

## Conventions

- Clarity over cleverness: small functions, descriptive names, plain JavaScript.
- Comments explain *why*, not *what*. No commented-out code.
- Validate all input in the backend; never trust the client.
- Write tests with every feature and bug fix (a failing test first for bugs). Backend
  changes always get simple tests: a few clear cases per endpoint, run on the local DB.
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
- Don't commit plans, scratch files, or debug output. Unfixed bugs and trade-offs
  go in [Known bugs and accepted trade-offs](#known-bugs-and-accepted-trade-offs).
