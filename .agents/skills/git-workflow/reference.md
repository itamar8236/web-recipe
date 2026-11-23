# Git workflow: reference

Details for the `git-workflow` skill ([`SKILL.md`](SKILL.md)).

## Set up a new worktree
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
  `local-dev` skill (`npm run db:copy-main` in `backend/` copies the main checkout's one).
- Windows: if `.claude/skills` is a small text file instead of a link, apply the fix in
  `AGENTS.md` → Agent setup in this worktree.
- The main checkout lives in OneDrive, so worktrees inside it (Claude Code's default
  `.claude/worktrees/`) get each `node_modules` synced too. Prefer a worktree location
  outside OneDrive (desktop app: Settings → Worktree location; Codex: its own folder).

## Let the owner test it
The owner tests PRs in their main checkout, which has their packages, `.dev.vars` and
local DB. A branch can be checked out in only one folder, so the owner checks the PR out
**detached** (`--detach`): the branch itself stays in your worktree, and you can keep
committing and pushing to it while they test.
Start **How to test** in the PR body with the owner's steps, saying only the extra
setup this PR needs:
```
1. `gh pr checkout <number> --detach`
2. (only if needed) `npm ci` in `frontend/` or `backend/`; `npm --prefix backend run db:schema:local`
3. `npm --prefix frontend run build; if ($?) { npm --prefix backend run dev }`, open http://localhost:8787
4. When done: Ctrl+C, then `git switch main`
```
Running `gh pr checkout <number> --detach` again picks up newer commits. If the owner did
check the branch out by name, don't wait for them: commit on a detached `HEAD` in your
worktree and push with `git push origin HEAD:<branch>`.

## Remove a worktree
After the merge (commit anything you want to keep first):
```bash
git worktree list
git worktree remove <path>      # refuses if it has changes; unlock it first if locked
git worktree prune              # forgets worktrees whose folder was deleted by hand
git branch -d <branch>
```
