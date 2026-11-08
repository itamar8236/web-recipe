---
name: frontend-ui
description: Guidance for building or changing UI in web-recipe's frontend/ (Next.js static export, plain JS, CSS Modules, English/Hebrew RTL). Use for any frontend visual or interaction work.
---

# Frontend UI work in web-recipe

Read `frontend/README.md` first (screens, UX rules, bilingual, API client). Match existing
components before inventing new ones. The app must stay extremely simple to use.

## Rules
- Plain JavaScript and CSS Modules. No TypeScript, UI kits, or CSS frameworks.
- Static export: no server components that fetch, no API routes, no dynamic route
  segments. Pass ids as query params (`/recipe?id=12`) and fetch on the client.
- Data only through `lib/api.js` (same-origin requests, so the session cookie is sent);
  never `fetch` inside components. The login screen is shown by `Shell`, not a `/login` route. Admin-only UI checks `user.is_admin`.
- Visible text only from `lib/i18n.js`, in both English and Hebrew.
- Use CSS logical properties (`margin-inline-start`, `text-align: start`) so Hebrew RTL
  works; colors and spacing come from the CSS variables in `styles/globals.css`.
- Every data screen handles loading, empty, error, and success. Disable submit buttons
  while a request runs (a video import runs in the background and shows progress on its card).
- Mobile first: ~360px up, no horizontal scroll, tap targets ≥ 44px.
- Accessibility: semantic HTML, labeled inputs, visible focus, good contrast.

## Before you finish
- Run `npm run lint` and `npm test` in `frontend/`.
- Check the change in a browser at phone and desktop widths, in English and Hebrew
  (run the app as in the `local-dev` skill).
- Attach screenshots to the PR for visible changes.
