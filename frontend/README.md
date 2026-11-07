# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's API (see `backend/README.md`). Read the root `CLAUDE.md` first.

## Current state: UI-only demo

Only the recipe browsing and manual add/edit/delete screens exist. There is **no login,
no database and no backend API yet**: `lib/api.js` keeps everything in memory (seeded
with a few sample recipes) and resets when the page is closed or reloaded. Its functions
are async and shaped like the future endpoints, so swapping in real `fetch` calls later
won't touch the components. Folders are a flat list for now (no nesting or reordering).
Every recipe view shows a "Source" line: a clickable link (opens in a new tab) when the
recipe has a `link`, otherwise plain "Added manually" text. The link is not editable in the
UI; it will be filled by video import. One sample recipe links to claude.ai as an example.

## Layout

Marked (planned) = not built yet.

```
frontend/
├── app/
│   ├── layout.js          # Root layout: wraps everything in the Shell
│   ├── manifest.js        # Web app manifest (makes the site installable on Android)
│   ├── icon.png           # Favicon
│   ├── page.js            # Home: folders + recipes in the selected folder
│   ├── login/page.js      # (planned) Username/email field only   (/login)
│   ├── admin/page.js      # (planned) Admin: list, add, delete users (/admin)
│   └── recipe/
│       ├── page.js        # View one recipe        (/recipe?id=12)
│       ├── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
│       └── import/page.js # (planned) Paste a video link, compare, save (/recipe/import)
├── components/            # Shell, Header, Language (context), FolderBar, RecipeCard, HeartButton, ConfirmDialog
├── public/                # sw.js (minimal service worker, caches nothing), icons/ (app icons)
├── lib/
│   ├── api.js             # The only data layer (in-memory for now; later the only fetch())
│   ├── api.test.js        # Vitest tests for api.js and i18n helpers
│   └── i18n.js            # UI strings in en/he + pickLanguage()
├── styles/globals.css     # Design tokens (CSS variables), buttons, form fields
└── next.config.mjs
```

- **Installable (PWA):** `app/manifest.js` + `public/sw.js` (registered in production only) let
  Chrome on Android offer "Install app". Icons are cropped from the Recipe Rocket logo into
  `public/icons/`. Needs HTTPS (fine on Cloudflare); it doesn't work on plain `http://` hosts.
- Static export can't use dynamic route segments without a build-time list, so recipe
  pages take the id as a **query parameter** and fetch on the client.
- Components are client components where they fetch or hold state; keep it simple.

## Login flow (planned)

- `AuthGate` (in the root layout) asks the backend who is logged in once on load:
  - logged in → render the app; on `/login`, redirect to home.
  - 401 → redirect to `/login`.
- `/login` has two fields ("Username or email" and "Password") and one button. On success
  go to home. The login is remembered, so users see this page only the first time on a
  device, after logging out, or after changing their password on another device.
- Wrong username/email or password shows one generic message (never which one was
  wrong); a locked account says to try again in a few minutes.
- If the admin set or reset the password, the user is sent to a "Choose a new password"
  screen before the app opens.
- Any API call returning 401 (e.g. the admin deleted the user) sends the user to `/login`.
- The current user is kept in a small React context; `is_admin` shows the "Users" link,
  and `acting_as` (the impersonated user, if any) shows the "Acting as" banner.

## Screens

Built now: Home, Recipe view, Edit. The rest are planned.

1. **Login** (planned): described above.
2. **Home**: folders with recipe counts. On phones only, they are one row of pills that
   scrolls sideways; on desktop, a side list with no scrolling;
   recipes of the selected folder as cards. Create, rename, and delete folders inline.
   Only an empty folder can be deleted (Delete looks disabled otherwise; tapping it shows a hint). Big "Add recipe" button. Each card has a
   heart to mark a favorite (once login exists, each user sees only their own folders, recipes, and favorites), and a "Favorites" toggle filters the list (combined with
   the selected folder). (Nesting,
   moving, and reordering folders are planned.)
3. **Add recipe**: two choices, "Paste video link" or "Write manually".
4. **Import**: URL field (YouTube or Facebook; others show "not supported yet"), a folder
   picker, a submit button, then a spinner with "Reading the video..." Then:
   - one candidate → show it as an editable preview with "Save".
   - several candidates → show them side by side (stacked on phones) with the model name
     and time taken; failed models show their error. The user taps "Use this one",
     can edit, then saves.
5. **Recipe view**: name, source link (opens the video), ingredients, steps. Heart, Edit
   and Delete buttons (delete asks for confirmation).
6. **Edit**: name, ingredients, and steps (one per line) in the app's current language,
   plus a folder picker. A short note explains that to write the other language you
   save, switch the language, and tap Edit; the other language's text is kept as is. A name in at least one
   language is required. If a language is left empty, the recipe view shows the other
   language with a "not written yet" note; later the backend will translate it.
7. **Users** (admin only): list of users, a form to add one (username, optional email,
   first password), and per user an "Act as" button, a "Reset password" button and a
   delete button (the last two with confirmation; deleting a user also deletes all their
   folders and recipes, and the dialog says so). Shows "N / 50 users".
   "Act as" opens Home showing that user's folders and recipes; every screen then works
   on their data, and a banner on every page says "Acting as <name>" with a "Stop"
   button that returns the admin to their own data.
8. **Change password** (planned): current password, new password, and Save. Reached
   from the header, and shown automatically after the admin sets or resets a password.

## UX rules

- Extremely simple: every action is reachable in 1-2 taps, with clear words on buttons
  (icons only alongside text).
- Mobile first: works from ~360px up, no horizontal scroll, large tap targets (≥ 44px).
- Every data screen handles loading, empty, error, and success states.
- Destructive actions ask for confirmation with `components/ConfirmDialog` (an in-page
  dialog). Don't use `window.confirm()`: some browsers and in-app views block it and it
  silently returns false.

## Bilingual (English / Hebrew)

- A language toggle in the header switches both the UI strings and the recipe content
  shown. Remember the choice in `localStorage`. The toggle is disabled on the add/edit
  page (until Save or Cancel), and the form writes the recipe in that language only.
- Hebrew sets `<html lang="he" dir="rtl">`. Use CSS logical properties
  (`margin-inline-start`, `padding-inline`, `text-align: start`) so layouts flip correctly.
- UI strings live only in `lib/i18n.js`; never hard-code visible text in components.

## API client

Today `lib/api.js` is the in-memory demo described above. The target design is:

- `lib/api.js` exports one function per endpoint (`login`, `getMe`, `getFolders`,
  `importRecipe`, ...) and throws an `Error` with the backend's message on failure.
- Every request uses `credentials: 'include'` so the session cookie is sent.
- Base URL is `process.env.NEXT_PUBLIC_API_BASE ?? ''`: empty in production (same
  origin), `http://localhost:8787` in local dev (set in `.env.local`).
