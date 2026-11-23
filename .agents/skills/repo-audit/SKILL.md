---
name: repo-audit
description: Periodic whole-repo audit of web-recipe - checks every .md file against the code (accurate, not too short, not too long, a good map of the code), traces the main user journeys end to end to find system bugs that single-feature work missed, and reviews the agent workflow. Read-only by default; reports findings ranked by severity. Use only when the owner asks for a repo audit, doc audit, or architecture health check.
disable-model-invocation: true
---

# Auditing web-recipe

A check-up run every few weeks, not part of a feature. The checklists for each part are
in [`reference.md`](reference.md).

## Rules for the run

- **Read-only by default.** Change no files unless the owner asked for `fix` mode.
- **Never** touch production, call a model (a real import or AI tool), or read `.env` /
  `.dev.vars` (`AGENTS.md` → Never do these). If a check needs the app running, follow
  `local-dev`.
- **Evidence or it didn't happen.** Every finding has `file:line`, the fact, the likely
  impact (with your confidence), and a suggested fix. A finding you only inferred, never
  confirmed in code, is at most Warning/Medium.
- Items in a Known gaps list or marked accepted (`AGENTS.md` → Known bugs and accepted
  trade-offs says where they all are) are known. Report one only if it got worse or its
  linked section is gone. Never "fix" an accepted one.
- Describe the code **as it is**, not as you think it should be.
- **In doubt about what a good doc or rule looks like**, look at T3 Code's agent docs:
  <https://github.com/pingdotgg/t3code> (`AGENTS.md`, `docs/`). Take its ideas (document
  only what code can't show, one source of truth, short "never do" lists), not its size.
  If that doesn't answer it, **ask the owner** instead of guessing.

## Modes

| Owner says | Mode | Does |
|------------|------|------|
| "audit", "check the repo" (default) | **audit** | Steps 1-5 (parts A, B and C), report only |
| "fix the docs", "audit and fix" | **fix** | Audit, then step 6: mechanical doc fixes in a PR |
| "docs only" / "architecture only" / "workflow only" | scope | Run only part A, B or C |

## Step 1: Prepare

Work in this session's own worktree (`git-workflow`), at the latest `origin/main`:
```bash
git fetch origin main && git rebase origin/main
git ls-files '*.md' | xargs wc -l          # every doc and its size
git log --since='60 days ago' --name-only --pretty=format:'' | sort -u   # what changed
```
Reports live in the **main checkout's** `.audit/` (git-ignored), never in a worktree's,
which is deleted with it. Find it with
`git worktree list --porcelain | head -1` (the first entry is the main checkout). Read the
newest report there: it's the baseline for step 4, with the owner's decisions on it.

## Steps 2-3: the three parts

Run each part in a **fresh subagent** (no memory of how features were built), with its
checklist from `reference.md`:

- **Part A, docs**: every tracked `.md` file is accurate, fresh, coherent, the right size,
  and a code map.
- **Part B, architecture**: trace each user journey through the real code and ask "what
  if it fails, runs twice, runs at the same time, or the user is gone?". Also
  `npm audit` in `backend/` and `frontend/` (report high or critical).
- **Part C, agent workflow**: safety rails, quality gates, the dev loop, git, deploys and
  migrations, dependencies, agent setup.

## Step 4: Verify, merge, compare

- For each Critical/High finding, ask a separate subagent to **disprove** it from the
  code. Refuted findings go to an appendix with the reason; unverified ones are labeled.
- Merge duplicates (same root cause), keep the highest severity.
- Compare with the previous report by (area, file, root cause), not line numbers: mark
  each finding `new` or `still open`, and list old ones as `resolved` only after opening
  the file to confirm. A finding the owner accepted there is not reported again.

## Step 5: Report

Severity: **Critical** = docs that send an agent the wrong way, or data loss, a security
hole, a feature broken now. **Warning/High** = stale or missing docs, silent wrong
results. **Info/Medium** = duplication, size, nice-to-have.

Save to the main checkout's `.audit/YYYY-MM-DD.md` in the format in `reference.md` →
Report format, and post a summary in chat. The owner adds their decisions to it.

## Step 6 (fix mode only): mechanical doc fixes

On this session's branch (`git-workflow`), fix only what needs no judgment: wrong paths,
commands, counts, names, broken links, routes missing from the API tables. Anything that
needs rewriting, a new section, or a product decision goes in the PR's "Notes /
follow-ups" for the owner. Workflow findings (part C) are never auto-fixed: they change
rules or settings, so list them for the owner. Never change code in an audit; each code
bug becomes its own `bug-fix` task once the owner agrees.
