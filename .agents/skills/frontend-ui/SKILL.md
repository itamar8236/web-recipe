---
name: frontend-ui
description: Guidance for building or changing UI in web-recipe's frontend/ (Next.js static export, plain JS, CSS Modules, English/Hebrew RTL). Use for any frontend visual or interaction work.
---

# Frontend UI work in web-recipe

Read `docs/internals/08_web-ui.md` first (data layer, screens' rules, traps, bilingual). Match existing
components before inventing new ones. The app must stay extremely simple to use.

## Rules
- Plain JavaScript and CSS Modules. No TypeScript, UI kits, or CSS frameworks.
- Static export: ids go in the query string and pages fetch on the client
  (`docs/internals/00_architecture.md` → Static export).
- Data only through `lib/api.js` (`08_web-ui.md` → Data layer); never `fetch` inside
  components. The login screen is shown by `Shell`, not a `/login` route.
- Visible text only from `lib/i18n.js`, in both English and Hebrew.
- Use CSS logical properties (`margin-inline-start`, `text-align: start`) so Hebrew RTL
  works; colors and spacing come from the CSS variables in `styles/globals.css`.
- Every data screen handles loading, empty, error, and success. Disable submit buttons
  while a request runs (an import runs in the background and shows progress on its card).
- Mobile first: ~360px up, no horizontal scroll, tap targets ≥ 44px.
- Accessibility: semantic HTML, labeled inputs, visible focus, good contrast.

## Before you finish
- Run `npm run lint` and `npm test` in `frontend/`.
- Check the change in a browser at phone and desktop widths, in English and Hebrew
  (run the app as in the `local-dev` skill).
- Attach screenshots to the PR for visible changes.
