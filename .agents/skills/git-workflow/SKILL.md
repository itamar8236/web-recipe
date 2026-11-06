---
name: git-workflow
description: Branch, commit, push and open a PR following this repo's conventions. Use whenever starting a new task, committing changes, or opening a pull request in web-recipe.
---

# Git workflow for web-recipe

Follow the rules in the root `CLAUDE.md` (section "Git workflow"). Summary:

## 1. Start a task
```bash
git checkout main
git pull origin main
git checkout -b <type>/<short-kebab-description>
```
Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`.
Never work directly on `main`.

## 2. Commit
- Stage only files related to the change (`git add <paths>`, avoid `git add -A` blindly).
- Message format (Conventional Commits):
  ```
  <type>(<scope>): <imperative summary ≤72 chars>

  <why, if not obvious>
  ```
  Scopes: `frontend`, `backend`, `db`, `config`, `deps`, or a feature area.
- One logical change per commit.

## 3. Before pushing
- Run lint and tests for each app you touched (commands in `CLAUDE.md` → Commands).
- Update `CLAUDE.md` if stack, commands, or conventions changed.

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
## How to test
## Notes / follow-ups
```

Never force-push to shared branches, never push to `main`, never merge your own PR
without the owner's approval.
