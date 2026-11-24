---
name: new-feature
description: End-to-end checklist for implementing a feature in web-recipe (backend Worker + D1, Next.js frontend, or both). Use when asked to build or add a feature.
---

# Implementing a feature in web-recipe

1. **Understand**: restate the feature in one or two sentences and decide which apps it
   touches. Build only that feature; keep the product goal (simple, free, few users)
   in mind but don't expand scope. Ask the owner if anything is ambiguous.
2. **Branch**: follow the `git-workflow` skill; the PR title starts with `feat`.
3. **Read the docs for the area**: its `docs/internals/` pages (index in `docs/README.md`),
   each with its Known gaps (never fix an accepted one without asking).
4. **Backend** (if needed):
   - All tables live in `backend/schema.sql` (only `IF NOT EXISTS`, safe to re-run).
     New tables go there; changing an existing table also needs a one-off `ALTER` (or
     table rebuild) in a new file in `backend/migrations/`, which the owner runs on
     production (`docs/internals/02_data.md` → Schema changes). The PR says when to run it.
   - Use bound SQL parameters only; keep LLM provider code in one place.
   - New routes require a session.
   - Validate input, return `{ error }` with the right status code.
   - Add simple Vitest tests (`@cloudflare/vitest-plugin`, local D1) for every
     new or changed endpoint: the happy path, bad input, and not logged in.
     Keep them small: a few clear cases, no elaborate fixtures.
   - Record new or changed endpoints, shapes and error codes in `docs/internals/01_api.md`.
5. **Frontend** (if needed): follow the `frontend-ui` skill. Call the API only through
   `lib/api.js`, and support both English and Hebrew.
6. **Verify**: lint and tests for every app touched; run the app against the local DB
   (`local-dev` skill, never production) and try the feature end to end in a browser.
7. **Document**: rewrite or delete every `.md` text the feature makes wrong, in the same PR:
   `AGENTS.md` (product, stack, commands, rules), `docs/` (decisions, the API, known gaps),
   skills (in `.agents/skills/` only). What belongs in a doc: `AGENTS.md` → Conventions → Docs.
8. **Ship**: commit and open a PR (`git-workflow`). Report what changed, how it was
   tested, and what's left.
