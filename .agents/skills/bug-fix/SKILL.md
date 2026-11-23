---
name: bug-fix
description: Steps for fixing a bug in web-recipe - reproduce, write a failing test, make the smallest fix, verify. Use when asked to fix a bug, error, or broken behavior.
---

# Fixing a bug in web-recipe

1. **Branch**: see `git-workflow`; the PR title starts with `fix`.
2. **Reproduce**: confirm the bug locally (dev servers on the local DB, see `local-dev`;
   a request; or a test) and find the
   root cause before editing. If you can't reproduce it, ask the owner for steps.
3. **Failing test first**: add a test that fails because of the bug. Backend bugs get a
   simple Vitest test in `backend/` too (local D1, never production).
4. **Smallest fix**: change only what the bug needs. No refactors or unrelated cleanups;
   mention anything else you noticed in the PR's "Notes / follow-ups", and add real bugs
   you leave unfixed to the Known gaps list of their area (`AGENTS.md` → Known bugs and
   accepted trade-offs says which).
5. **Verify**: the new test passes, lint and the app's tests pass, and for UI bugs the
   behavior is correct in the browser (phone + desktop, English + Hebrew if relevant),
   running against the local DB (`local-dev`).
6. **Document**: if the fix changes behavior, the API, schema, or commands, update the
   matching `.md` files (`AGENTS.md`, `backend/README.md`, `backend/IMPORT.md`, `frontend/README.md`, skills).
7. **Ship**: commit `fix(<scope>): ...` and open a PR describing cause and fix.
