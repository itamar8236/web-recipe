---
name: new-feature
description: End-to-end checklist for implementing a feature in web-recipe (backend Worker + D1, Next.js frontend, or both). Use when asked to build or add a feature.
---

# Implementing a feature in web-recipe

1. **Understand**: restate the feature in one or two sentences and decide which apps it
   touches. Build only that feature; keep the product goal (simple, free, few users)
   in mind but don't expand scope. Ask the owner if anything is ambiguous.
2. **Branch**: follow the `git-workflow` skill (`feat/<description>`).
3. **Read the docs for the area**: `backend/README.md` (data model, API, LLM flow) and/or
   `frontend/README.md` (screens, UX, bilingual rules).
4. **Backend** (if needed):
   - Schema change → add a new numbered file in `backend/migrations/`; never edit an
     applied migration.
   - SQL only in `db.js` with bound parameters; LLM calls only in `llm.js`.
   - Validate input, return `{ error }` with the right status code.
   - Add Vitest tests for the handler.
   - Update the API table in `backend/README.md`.
5. **Frontend** (if needed): follow the `frontend-ui` skill. Call the API only through
   `lib/api.js`, and support both English and Hebrew.
6. **Verify**: lint and tests for every app touched; run both dev servers and try the
   feature end to end in a browser.
7. **Document**: update `CLAUDE.md` / READMEs if commands, stack, structure, or the API
   changed.
8. **Ship**: commit and open a PR (`git-workflow`). Report what changed, how it was
   tested, and what's left.
