# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's `/api/*` (contract in `backend/README.md`). Read the root `CLAUDE.md` first.

## Layout (planned)

```
frontend/
├── app/
│   ├── layout.js          # Shell: header, language toggle, sets <html lang dir>
│   ├── page.js            # Home: folder tree + recipes in the selected folder
│   └── recipe/
│       ├── page.js        # View one recipe        (/recipe?id=12)
│       ├── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
│       └── import/page.js # Paste a video link     (/recipe/import)
├── components/            # Small reusable pieces: FolderTree, RecipeCard, ...
├── lib/
│   ├── api.js             # The only place that calls fetch()
│   └── i18n.js            # UI strings in en/he + current-language helper
├── styles/globals.css     # Design tokens (CSS variables) and base styles
└── next.config.mjs
```

- Static export can't use dynamic route segments without a build-time list, so recipe
  pages take the id as a **query parameter** and fetch on the client.
- Components are client components where they fetch or hold state; keep it simple.

## Screens

1. **Home**: folder tree on the side (a drawer on phones), recipes of the selected folder
   as a list. Create, rename, move, and delete folders inline. Big "Add recipe" button.
2. **Add recipe**: two choices, "Paste video link" or "Write manually".
3. **Import**: one URL field, a folder picker, a submit button, then a spinner with
   "Reading the video..." until the recipe opens.
4. **Recipe view**: name, source link (opens the video), ingredients, steps. Edit and
   Delete buttons (delete asks for confirmation).
5. **Edit**: name, ingredients, and steps for the current language, with a switch to edit
   the other one. If the other language is left empty, the backend translates it.

## UX rules

- Extremely simple: every action is reachable in 1-2 taps, with clear words on buttons
  (icons only alongside text).
- Mobile first: works from ~360px up, no horizontal scroll, large tap targets (≥ 44px).
- Every data screen handles loading, empty, error, and success states.
- Destructive actions ask for confirmation.

## Bilingual (English / Hebrew)

- A language toggle in the header switches both the UI strings and the recipe content
  shown. Remember the choice in `localStorage`.
- Hebrew sets `<html lang="he" dir="rtl">`. Use CSS logical properties
  (`margin-inline-start`, `padding-inline`, `text-align: start`) so layouts flip correctly.
- UI strings live only in `lib/i18n.js`; never hard-code visible text in components.

## API client

- `lib/api.js` exports one function per endpoint (`getFolders`, `importRecipe`, ...),
  throws an `Error` with the backend's message on failure.
- Base URL is `process.env.NEXT_PUBLIC_API_BASE ?? ''`: empty in production (same
  origin), `http://localhost:8787` in local dev (set in `.env.local`).
