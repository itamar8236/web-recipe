# CLAUDE.md

Guidance for every coding agent (Claude Code, Codex, and others) and human contributor
working in this repository. This file is the **single source of truth**: `AGENTS.md`
points here. Read it fully before making changes, and keep it current.

## What we're building

**web-recipe** is a full-stack web application for recipes (browse, create, and manage
recipes). The project is in its **initial setup phase**: product scope and tech stack
will be added here as decisions are made.

> TODO (owner): expand on features, target users, and the chosen stack.

## Principles

- **Simple first.** Build the smallest thing that solves the problem. YAGNI: no
  speculative abstractions, config, or dependencies.
- **Measure twice, cut once.** Read the surrounding code and this file before editing.
  Ask the owner when requirements are ambiguous instead of guessing.
- **Leave it better documented.** If you change commands, stack, layout, or
  conventions, update this file in the same PR.

## Glossary

- **Owner**: the human who owns this repo and approves PRs.
- **Agent**: any AI coding assistant working in the repo (Claude Code, Codex, ...).
- **Backend**: the server app in `backend/` (API, business logic, database).
- **Frontend**: the browser app in `frontend/` (UI).
- **Skill**: a step-by-step playbook in `.agents/skills/<name>/SKILL.md`.

## Ways to hurt yourself (never do these)

- Commit or push directly to `main`, or force-push any shared branch.
- Commit secrets. `.env` files are git-ignored; commit a `.env.example` instead.
  Don't read or print `.env` contents.
- Import code across `backend/` and `frontend/`. They talk only over the HTTP API.
- Add a framework, language, or major dependency without the owner's approval.
- Merge your own PR without the owner's approval.

## Where code lives

```
.
├── backend/          # Server app: API, business logic, database access
├── frontend/         # Browser app: UI
├── .agents/skills/   # Shared agent skills (source of truth)
├── .claude/          # Claude Code config: settings.json, skills mirror
├── scripts/          # Repo maintenance scripts
├── AGENTS.md         # Entry point for non-Claude agents, points here
└── CLAUDE.md         # This file
```

- `backend/` and `frontend/` are independent: each has its own dependencies, config,
  scripts, and README.
- The API contract is documented in `backend/README.md` (or an OpenAPI spec once one
  exists). Change the contract and its docs in the same PR.

## Tech stack

Not decided yet. When chosen, record it here in the same PR:

| Area      | Choice | Notes |
|-----------|--------|-------|
| Frontend  | TBD    |       |
| Backend   | TBD    |       |
| Database  | TBD    |       |
| Testing   | TBD    |       |
| Hosting   | TBD    |       |

## Commands

Fill in once each app is scaffolded:

| Task                | Backend | Frontend |
|---------------------|---------|----------|
| Install deps        | TBD     | TBD      |
| Run dev server      | TBD     | TBD      |
| Run tests           | TBD     | TBD      |
| Lint / format       | TBD     | TBD      |
| Build               | TBD     | TBD      |

## Verifying

Before every push:

- Run lint and tests for each app you touched (see Commands). Prefer focused tests for
  the code you changed over the whole suite.
- For UI changes, run the app and check the change in a browser at mobile and desktop
  widths.
- Never report work as done if checks fail or weren't run; say exactly what was and
  wasn't verified.

## Git workflow

All work happens on a branch and lands through a Pull Request into `main`.

### Branch names

Format: `<type>/<short-kebab-description>` (lowercase, hyphens, ≤ 5 words).

| Type       | Use for                                      | Example                   |
|------------|----------------------------------------------|---------------------------|
| `feat`     | New feature                                  | `feat/recipe-search`      |
| `fix`      | Bug fix                                      | `fix/login-redirect-loop` |
| `chore`    | Tooling, config, deps, setup                 | `chore/project-setup`     |
| `refactor` | Code change with no behavior change          | `refactor/recipe-service` |
| `docs`     | Documentation only                           | `docs/api-endpoints`      |
| `test`     | Adding or fixing tests only                  | `test/recipe-api`         |
| `style`    | Formatting / UI styling with no logic change | `style/navbar-spacing`    |

Optional scope for clarity: `feat/frontend-recipe-card`, `fix/backend-auth-token`.

### Commit messages: Conventional Commits

```
<type>(<scope>): <imperative summary, ≤ 72 chars, no trailing period>

<optional body: what and WHY, wrapped at ~72 chars>

<optional footer: Closes #12, BREAKING CHANGE: ...>
```

- `type`: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`, `perf`, `ci`, `build`
- `scope`: `frontend`, `backend`, `db`, `config`, `deps`, `agents`, or a feature area
  (`recipes`, `auth`)
- Examples: `feat(backend): add GET /recipes endpoint`,
  `fix(frontend): prevent double submit on recipe form`
- One logical change per commit. AI agents end commit messages with a
  `Co-Authored-By:` trailer naming the model used.

### Pull requests

- Title uses the Conventional Commit format.
- Body sections: **Summary**, **Changes**, **How to test**, **Notes / follow-ups**.
  Add screenshots for visible UI changes. Link issues with `Closes #N`.
- Keep PRs small and focused; split large work.
- Open with `gh pr create` when the GitHub CLI is available, otherwise via
  `https://github.com/itamar8236/web-recipe/compare/main...<branch>`.
- Merge only after the owner's review; delete the branch after merge.

### Standard agent workflow

1. `git checkout main && git pull`
2. `git checkout -b <type>/<description>`
3. Make focused changes, following existing patterns in the folder you're editing.
4. Verify (see Verifying).
5. Commit with Conventional Commit messages.
6. `git push -u origin <branch>` and open a PR against `main`.
7. Report what changed, what was verified, and what's left.

## Plans and work artifacts

- Don't commit plans, scratch files, or debug output. Track work in GitHub issues and PRs.

## Taste (refine once the stack is set)

- Clarity over cleverness: small functions, descriptive names.
- Comments explain *why*, not *what*. Don't leave commented-out code.
- Validate all input on the backend; never trust the client.
- Write tests alongside new features and bug fixes.

## Agent setup

- **Skills** live in `.agents/skills/` (read by all agents). `.claude/skills/` is a
  copy for Claude Code. Edit skills only in `.agents/skills/`, then run
  `bash scripts/sync-skills.sh` and commit both folders.
  - `git-workflow`: branch, commit, push, open a PR
  - `new-feature`: feature checklist across backend and frontend
  - `frontend-ui`: UI work in `frontend/`
- **Claude Code settings**: `.claude/settings.json` (committed) denies force-pushes,
  direct pushes to `main`, and reading `.env` files. Personal overrides go in
  `.claude/settings.local.json` (git-ignored).
- No plugins are required. Contributors may install optional Claude Code plugins for
  themselves, but anything the project depends on goes in as a skill.
