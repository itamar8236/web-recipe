---
name: frontend-ui
description: Guidance for building or changing UI in web-recipe's frontend/ (pages, components, styling, forms). Use for any frontend visual or interaction work.
---

# Frontend UI work in web-recipe

Stack: see "Tech stack" in the root `CLAUDE.md`. Follow existing patterns in `frontend/`
before inventing new ones.

## Before you build
- Find an existing component or page that does something similar and match its
  structure, naming and styling approach.
- Reuse shared components and design tokens (colors, spacing, fonts) instead of
  hard-coding values. If a token is missing, add it in one shared place.

## While building
- Data comes from the backend only through the frontend's API client module, never
  ad-hoc `fetch` calls inside components.
- Every screen that loads data handles four states: loading, empty, error, success.
- Forms: label every input, validate on the client for UX, and still expect the
  backend to reject bad input. Disable submit while a request is in flight.
- Layout must work from phone width (~360px) to desktop. No horizontal scroll.
- Accessibility: semantic HTML (`button`, `nav`, `main`, headings in order),
  visible focus styles, alt text on recipe images, sufficient color contrast.
- Keep components small; move logic that isn't about rendering into hooks or helpers.

## Before you finish
- Run the app and look at the change in a browser at mobile and desktop widths.
- Run frontend lint and tests (commands in `CLAUDE.md` → Commands).
- For visible changes, attach a screenshot to the PR description.
