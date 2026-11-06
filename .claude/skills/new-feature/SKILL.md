---
name: new-feature
description: End-to-end checklist for implementing a feature in web-recipe (backend Worker + D1, Next.js frontend, or both). Use when asked to build or add a feature.
---

# Implementing a feature in web-recipe

1. **Understand**: restate the feature in one or two sentences and decide which apps it
   touches. Build only that feature; keep the product goal (simple, free, few users)
   in mind but don't expand scope. Ask the owner if anything is ambiguous.
2. **Branch**: follow the `git-workflow` skill (`feat/<description>`).
3. **Read the docs for the area**: `backend/README.md` (data, login, video import) and/or
   `frontend/README.md` (screens, UX, bilingual rules).
4. **Backend** (if needed):
   - Schema changes go through new migrations; never edit an applied one.
   - Use bound SQL parameters only; keep LLM provider code in one place.
   - New routes require a session (admin routes also the admin check).
   - Validate input, return `{ error }` with the right status code.
   - Add Vitest tests for the handler.
   - Record new endpoints and schema in `backend/README.md`.
5. **Frontend** (if needed): follow the `frontend-ui` skill. Call the API only through
   `lib/api.js`, and support both English and Hebrew.
6. **Verify**: lint and tests for every app touched; run both dev servers and try the
   feature end to end in a browser.
7. **Document**: update every `.md` file the feature makes outdated, in the same PR:
   `CLAUDE.md` (product, stack, commands, rules), `backend/README.md` (schema, API, auth,
   LLM flow, env), `frontend/README.md` (screens, UX), skills (then run
   `bash scripts/sync-skills.sh`).
8. **Ship**: commit and open a PR (`git-workflow`). Report what changed, how it was
   tested, and what's left.
