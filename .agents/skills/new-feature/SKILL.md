---
name: new-feature
description: End-to-end checklist for implementing a feature that spans backend and frontend in web-recipe. Use when asked to build or add a feature.
---

# Implementing a feature in web-recipe

1. **Understand** — restate the feature, identify whether it touches `backend/`,
   `frontend/`, or both. Ask the owner if requirements are ambiguous.
2. **Branch** — follow the `git-workflow` skill (`feat/<description>`).
3. **Backend first** (if needed):
   - Define/extend the API contract and document it in `backend/README.md`.
   - Implement with input validation and error handling.
   - Add tests.
4. **Frontend** (if needed):
   - Consume the API only through a dedicated API/client module, not ad-hoc fetches
     scattered across components.
   - Handle loading, empty, and error states.
   - Follow the `frontend-ui` skill for UI work.
5. **Verify** — run tests/lint for both apps; run the app and check the feature works.
6. **Document** — update `CLAUDE.md` / READMEs if commands, stack, or structure changed.
7. **Ship** — commit with Conventional Commits and open a PR (see `git-workflow`).
   Report what changed, how it was tested, and anything left undone.
