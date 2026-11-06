# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's `/api/*` (contract in `backend/README.md`). Read the root `CLAUDE.md` first.

## Layout (planned)

```
frontend/
├── app/
│   ├── layout.js          # Shell: header, language toggle, logout, sets <html lang dir>
│   ├── page.js            # Home: folder tree + recipes in the selected folder
│   ├── login/page.js      # Username/email field only        (/login)
│   ├── admin/page.js      # Admin: list, add, delete users   (/admin)
│   └── recipe/
│       ├── page.js        # View one recipe        (/recipe?id=12)
│       ├── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
│       └── import/page.js # Paste a video link, compare, save (/recipe/import)
├── components/            # Small reusable pieces: FolderTree, RecipeCard, AuthGate, ...
├── lib/
│   ├── api.js             # The only place that calls fetch()
│   └── i18n.js            # UI strings in en/he + current-language helper
├── styles/globals.css     # Design tokens (CSS variables) and base styles
└── next.config.mjs
```

- Static export can't use dynamic route segments without a build-time list, so recipe
  pages take the id as a **query parameter** and fetch on the client.
- Components are client components where they fetch or hold state; keep it simple.

## Login flow

- `AuthGate` (in the root layout) calls `GET /api/auth/me` once on load:
  - logged in → render the app; on `/login`, redirect to home.
  - 401 → redirect to `/login`.
- `/login` has one field ("Username or email") and one button. On success go to home.
  Because the session cookie lasts a year and renews on use, users see this page only
  the first time on a device or after logging out.
- Any API call returning 401 (e.g. the admin deleted the user) sends the user to `/login`.
- The current user is kept in a small React context; `is_admin` shows the "Users" link.

## Screens

1. **Login**: described above.
2. **Home**: folder tree on the side (a drawer on phones), recipes of the selected folder
   as a list. Create, rename, move, and delete folders inline. Big "Add recipe" button.
3. **Add recipe**: two choices, "Paste video link" or "Write manually".
4. **Import**: URL field (YouTube or Facebook; others show "not supported yet"), a folder
   picker, a submit button, then a spinner with "Reading the video..." Then:
   - one candidate → show it as an editable preview with "Save".
   - several candidates → show them side by side (stacked on phones) with the model name
     and time taken; failed models show their error. The user taps "Use this one",
     can edit, then saves.
5. **Recipe view**: name, source link (opens the video), ingredients, steps. Edit and
   Delete buttons (delete asks for confirmation).
6. **Edit**: name, ingredients, and steps for the current language, with a switch to edit
   the other one. If the other language is left empty, the backend translates it.
7. **Users** (admin only): list of users, a form to add one (username, optional email),
   and a delete button per user with confirmation. Shows "N / 50 users".

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

- `lib/api.js` exports one function per endpoint (`login`, `getMe`, `getFolders`,
  `importRecipe`, ...) and throws an `Error` with the backend's message on failure.
- Every request uses `credentials: 'include'` so the session cookie is sent.
- Base URL is `process.env.NEXT_PUBLIC_API_BASE ?? ''`: empty in production (same
  origin), `http://localhost:8787` in local dev (set in `.env.local`).
