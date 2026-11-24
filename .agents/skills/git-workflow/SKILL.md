---
name: git-workflow
description: Branch, commit, push and open a PR following this repo's conventions. Use whenever starting a new task, committing changes, or opening a pull request in web-recipe.
---

# Git workflow for web-recipe

All work lands in `main` through a Pull Request. This skill is the workflow;
[`reference.md`](reference.md) has the details (worktree setup and removal, how the owner
tests a PR).

## 1. Start a task
Every task (every agent session) runs in its **own git worktree**, so parallel sessions
never edit, build or switch branches in each other's files. Never work in the main
checkout or directly on `main`.

Check where you are: `git rev-parse --git-dir --git-common-dir` prints two different
paths inside a worktree and the same path in the main checkout.

- **Already in a worktree** (the usual case: the desktop app's **Worktree** option, Claude
  Code `--worktree`, Codex): never create a second one. Keep the branch the tool made
  (e.g. `claude/<name>`); just make sure it starts from the latest `origin/main`:
  `git fetch origin main && git rebase origin/main`.
- **In the main checkout** (no worktree yet), create one, outside OneDrive
  (`reference.md` → Set up a new worktree):
  ```bash
  git fetch origin main
  git worktree add -b <type>/<short-kebab-description> <path> origin/main
  ```
  Branch name: lowercase, hyphens, ≤ 5 words (e.g. `feat/recipe-import`).

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`. The PR title carries
the type, whatever the branch is called. A branch can be checked out in only one
worktree at a time.

## 2. Commit
- Stage only files related to the change (`git add <paths>`, avoid `git add -A` blindly).
- Message format (Conventional Commits):
  ```
  <type>(<scope>): <imperative summary ≤72 chars>

  <why, if not obvious>
  ```
  Scopes: `frontend`, `backend`, `db`, `llm`, `config`, `deps`, `agents`, or a feature area
  (`recipes`, `tags`, `import`).
- One logical change per commit.
- AI agents end the message with a `Co-Authored-By:` trailer naming the model used.

## 3. Before pushing
- Update every `.md` file your change makes wrong (`AGENTS.md`, `docs/`, the READMEs,
  skills) in the same branch (`AGENTS.md` → Conventions → Docs).
- Run lint and tests for each app you touched (`AGENTS.md` → Commands); never push
  failing checks. There is no CI: these are the only checks.

## 4. Push and open a PR
```bash
git push -u origin <branch>
```
Open the PR against `main` (with `gh pr create` if the GitHub CLI is installed,
otherwise via `https://github.com/itamar8236/web-recipe/compare/main...<branch>`).

PR title = Conventional Commit format. Body:
```
## Summary
## Changes
## How to test      (owner's steps first: reference.md → Let the owner test it)
## Notes / follow-ups
```
Add screenshots for visible UI changes.

**Size**: aim for a PR under ~400 changed lines (tests and docs included). If a feature
is bigger, split it (for example backend + schema first, then the UI) and say so in the PR.

If the PR breaks anything, say under Notes (and in chat) what the owner must do and
when relative to merging, and what breaks and for how long (`AGENTS.md` → How to work here).

Never force-push to shared branches, never push to `main`, and never merge a PR: only
the owner merges. GitHub deletes the branch after the merge.

## 5. After the merge
Remove the worktree (`reference.md` → Remove a worktree); Claude Code and Codex usually do
it when the session is closed or archived.
