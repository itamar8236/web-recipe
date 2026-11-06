# CLAUDE.md

Guidance for Claude Code and any other AI agent (or human) working in this repository.
Read this file fully before making changes.

## Project overview

**web-recipe** is a full-stack web application for recipes (browse, create, and manage recipes).
The project is in its **initial setup phase**: the product scope and tech stack will be
defined and added to this file as decisions are made.

> TODO (owner): expand on features, target users, and the chosen stack.

## Repository layout

```
.
├── backend/      # Server-side app: API, business logic, database access
├── frontend/     # Client-side app: UI served to the browser
├── .claude/      # Shared Claude Code config (settings, project skills)
└── CLAUDE.md     # This file
```

- Keep backend and frontend **independent**: each has its own dependencies, config,
  scripts, and README. Do not import code across the two folders; they communicate
  only over the HTTP API.
- Shared contracts (API shapes) should be documented in `backend/README.md` (or an
  OpenAPI spec once one exists).

## Tech stack

Not decided yet. When the stack is chosen, record it here:

| Area      | Choice | Notes |
|-----------|--------|-------|
| Frontend  | TBD    |       |
| Backend   | TBD    |       |
| Database  | TBD    |       |
| Testing   | TBD    |       |
| Hosting   | TBD    |       |

Do not introduce a framework, language, or major dependency without the owner's approval;
once chosen, update this table in the same PR.

## Commands

Fill in once each app is scaffolded:

| Task                | Backend | Frontend |
|---------------------|---------|----------|
| Install deps        | TBD     | TBD      |
| Run dev server      | TBD     | TBD      |
| Run tests           | TBD     | TBD      |
| Lint / format       | TBD     | TBD      |
| Build               | TBD     | TBD      |

## Git workflow

`main` is protected in practice: **never commit or push directly to `main`**.
All work happens on a branch and lands through a Pull Request.

### Branch names

Format: `<type>/<short-kebab-description>`

| Type       | Use for                                         | Example                         |
|------------|-------------------------------------------------|---------------------------------|
| `feat`     | New feature                                     | `feat/recipe-search`            |
| `fix`      | Bug fix                                         | `fix/login-redirect-loop`       |
| `chore`    | Tooling, config, deps, setup                    | `chore/project-setup`           |
| `refactor` | Code change with no behavior change             | `refactor/recipe-service`       |
| `docs`     | Documentation only                              | `docs/api-endpoints`            |
| `test`     | Adding or fixing tests only                     | `test/recipe-api`               |
| `style`    | Formatting / UI styling with no logic change    | `style/navbar-spacing`          |

Optional scope for clarity: `feat/frontend-recipe-card`, `fix/backend-auth-token`.
Lowercase, hyphens only, keep it short (≤ 5 words).

### Commit messages — Conventional Commits

```
<type>(<scope>): <imperative summary, ≤ 72 chars, no trailing period>

<optional body: what and WHY, wrapped at ~72 chars>

<optional footer: Closes #12, BREAKING CHANGE: ...>
```

- `type`: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`, `perf`, `ci`, `build`
- `scope`: `frontend`, `backend`, `db`, `config`, `deps`, or a feature area (`recipes`, `auth`)
- Examples:
  - `feat(backend): add GET /recipes endpoint`
  - `fix(frontend): prevent double submit on recipe form`
  - `chore(config): add shared Claude Code settings`
- One logical change per commit. Don't mix unrelated changes.
- AI agents end commit messages with a `Co-Authored-By:` trailer for the model used.

### Pull requests

- Title follows the same Conventional Commit format as commits.
- Body sections: **Summary**, **Changes**, **How to test**, **Notes / follow-ups**.
- Link related issues (`Closes #N`).
- Keep PRs small and focused; split large work into multiple PRs.
- Before opening a PR: tests and lint pass locally for the parts you touched, and
  this file is updated if commands, stack, or conventions changed.
- Merge into `main` only after review. Delete the branch after merge.

### Standard agent workflow

1. `git checkout main && git pull` — start from up-to-date `main`.
2. `git checkout -b <type>/<description>` — create a branch per task.
3. Make focused changes; follow existing patterns in the folder you're editing.
4. Run tests/lint for the affected app(s).
5. Commit with Conventional Commit messages.
6. `git push -u origin <branch>` and open a PR against `main`.
7. Report what changed, what was tested, and what's left.

The project skills `git-workflow` and `new-feature` in `.claude/skills/` encode these steps.

## Coding conventions (general, refine once stack is set)

- Prefer clarity over cleverness; small functions, descriptive names.
- No secrets in the repo. Use `.env` files (git-ignored) and commit a `.env.example`.
- Validate all input on the backend; never trust the client.
- Write tests alongside new features and bug fixes.
- Keep this file current — it is the source of truth for future agents.

## Claude Code setup

- Shared settings: `.claude/settings.json` (committed, to be added). Personal overrides
  go in `.claude/settings.local.json` (git-ignored).
- Recommended plugins (from `anthropics/claude-plugins-official`; install per user, or
  enable for everyone via `enabledPlugins` in `.claude/settings.json`):
  - `frontend-design` — UI/UX implementation guidance
  - `commit-commands` — `/commit`, `/commit-push-pr` helpers
  - `code-review` — PR review
- Project skills: `.claude/skills/git-workflow`, `.claude/skills/new-feature`.
