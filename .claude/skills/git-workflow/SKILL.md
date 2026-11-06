---
name: git-workflow
description: Branch, commit, push and open a PR following this repo's conventions. Use whenever starting a new task, committing changes, or opening a pull request in web-recipe.
---

# Git workflow for web-recipe

All work lands in `main` through a Pull Request. This skill is the full workflow.

## 1. Start a task
```bash
git checkout main
git pull origin main
git checkout -b <type>/<short-kebab-description>
```
Branch name: lowercase, hyphens, ≤ 5 words (e.g. `feat/recipe-import`, `fix/rtl-ingredients`).
Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`.
Never work directly on `main`.

## 2. Commit
- Stage only files related to the change (`git add <paths>`, avoid `git add -A` blindly).
- Message format (Conventional Commits):
  ```
  <type>(<scope>): <imperative summary ≤72 chars>

  <why, if not obvious>
  ```
  Scopes: `frontend`, `backend`, `db`, `llm`, `config`, `deps`, `agents`, or a feature area
  (`recipes`, `folders`, `import`).
- One logical change per commit.
- AI agents end the message with a `Co-Authored-By:` trailer naming the model used.

## 3. Before pushing
- Update every `.md` file whose content your change affects (`CLAUDE.md`,
  `backend/README.md`, `frontend/README.md`, skills) in the same branch.
- Run lint and tests for each app you touched (`CLAUDE.md` → Commands); never push
  failing checks.
- Bring in the latest `main`:
  ```bash
  git fetch origin
  git rebase origin/main      # first push of this branch
  ```
  Resolve conflicts, then re-run the checks. If the branch was **already pushed**, use
  `git merge origin/main` instead (rebasing would need a force-push, which is forbidden).

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
Add screenshots for visible UI changes and `Closes #N` for linked issues. Keep PRs
small and focused; the branch is deleted after the owner merges.

Never force-push to shared branches, never push to `main`, never merge your own PR
without the owner's approval.
