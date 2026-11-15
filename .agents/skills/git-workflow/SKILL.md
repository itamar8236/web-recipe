---
name: git-workflow
description: Branch, commit, push and open a PR following this repo's conventions. Use whenever starting a new task, committing changes, or opening a pull request in web-recipe.
---

# Git workflow for web-recipe

All work lands in `main` through a Pull Request. This skill is the full workflow.

## 1. Start a task
Every task (every agent session) runs in its **own git worktree**, so parallel sessions
never edit, build or switch branches in each other's files. Never work in the main
checkout or directly on `main`.

First check where you are: `git rev-parse --git-dir --git-common-dir` prints two
different paths inside a worktree and the same path in the main checkout.

**Already in a worktree** (the usual case: the desktop app's **Worktree** option, Claude
Code `--worktree`, Codex): never create a second one. Start your branch here from the
latest `origin/main` and delete the branch the tool made for the session (e.g.
`claude/<name>`), so it isn't left behind:
```bash
git fetch origin main
git switch --no-track -c <type>/<short-kebab-description> origin/main
git branch -d @{-1}
```
(`--no-track` keeps the new branch from tracking `main`; `git push -u` sets its own upstream.)

**In the main checkout** (no worktree yet), create one (outside OneDrive is better, see below):
```bash
git fetch origin main
git worktree add -b <type>/<short-kebab-description> <path> origin/main
cd <path>
```
Branch name: lowercase, hyphens, ≤ 5 words (e.g. `feat/recipe-import`, `fix/rtl-ingredients`).
Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`.
Always branch from a freshly fetched `origin/main`, not from whatever `HEAD` the worktree
started on. A branch can be checked out in only one worktree at a time.

### Set up a new worktree
A worktree holds only tracked files:
- Packages: in Claude Code a `SessionStart` hook (`.claude/hooks/install-deps.mjs`, set in
  `.claude/settings.json`) runs `npm ci` in `backend/` and `frontend/` when their
  `node_modules` is missing, so a new session can test at once (the first start takes about
  a minute). Elsewhere (Codex, `git worktree add`), or if the hook reports a failure, run
  `npm ci` in both folders yourself before running anything.
- `backend/.dev.vars` (dev keys) is git-ignored, so it isn't there. Never read or copy it
  yourself. Claude Code and Codex copy the files listed in `.worktreeinclude` into the
  worktrees they create; for a worktree made with `git worktree add`, ask the owner to
  copy it in. Tests don't need it; only real imports do.
- The local DB (`backend/.wrangler/state`) is per worktree and starts empty: follow the
  `local-dev` skill (empty copy → ask the owner, or `npm run db:schema:local`).
- Windows: if `.claude/skills` is a small text file instead of a link, apply the fix in
  `AGENTS.md` → Agent setup in this worktree.
- The repo lives in OneDrive, so worktrees inside it (Claude Code's default
  `.claude/worktrees/`) get each `node_modules` synced too. Prefer a worktree location
  outside OneDrive (desktop app: Settings → Worktree location; Codex: its own folder).

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
- Update every `.md` file whose content your change affects (`AGENTS.md`,
  `backend/README.md`, `frontend/README.md`, skills) in the same branch.
- Run lint and tests for each app you touched (`AGENTS.md` → Commands); never push
  failing checks.

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
## How to test      (owner's steps first: see "Let the owner test it")
## Notes / follow-ups
```
Add screenshots for visible UI changes and `Closes #N` for linked issues. Keep PRs
small and focused; the branch is deleted after the owner merges.
If the PR breaks anything, say under Notes (and in chat) what the owner must do and
when relative to merging, and what breaks and for how long (`AGENTS.md` → How to work here).

Never force-push to shared branches, never push to `main`, never merge your own PR
without the owner's approval.

### Let the owner test it
The owner tests PRs in their main checkout, which has their packages, `.dev.vars` and
local DB. A branch can be checked out in only one folder, so after every push free it:
```bash
git switch --detach
```
Start **How to test** in the PR body with the owner's steps, saying only the extra
setup this PR needs:
```
1. `gh pr checkout <number>`
2. (only if needed) `npm install` in `frontend/` or `backend/`; `npm --prefix backend run db:schema:local`
3. `npm --prefix frontend run build; if ($?) { npm --prefix backend run dev }`, open http://localhost:8787
4. When done: Ctrl+C, then `git switch main`
```
Running `gh pr checkout <number>` again picks up newer commits. To add commits later,
take the branch back in your worktree first: `git switch <branch>` (if the owner has it
checked out, ask them to `git switch main`).

## 5. After the merge
Remove the worktree (Claude Code and Codex usually do this when the session is closed or
archived; commit anything you want to keep first):
```bash
git worktree list
git worktree remove <path>      # refuses if it has changes; unlock it first if locked
git worktree prune              # forgets worktrees whose folder was deleted by hand
git branch -d <branch>
```
