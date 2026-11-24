# Frontend

The web-recipe UI: Next.js (App Router), plain JavaScript and CSS Modules, built as a static
export (`npm run build` → `out/`) that the backend Worker serves. Read the root `AGENTS.md`
first; how it works is in [Web UI](../docs/internals/08_web-ui.md), and the coding rules are
the `frontend-ui` skill.

- `app/`: the screens (ids go in the query string, `/recipe?id=12`).
- `components/`: one component per piece of UI, each with its CSS Module.
- `lib/api.js`: the only data layer (the backend, or memory for a guest); `lib/i18n.js`:
  every visible string in English and Hebrew; the rest of `lib/` is small helpers, each with
  its `*.test.js` beside it.
- `public/sw.js`: the service worker, which receives Android shares and caches no pages.
- `styles/globals.css`: design tokens (CSS variables), buttons and form fields.

Commands are in `AGENTS.md` → Commands; running it locally is the `local-dev` skill.
