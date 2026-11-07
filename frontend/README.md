# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's API (see `backend/README.md`). Read the root `AGENTS.md` first.

## Current state: UI only

The recipe browsing and manual add/edit/delete screens exist, plus login, sign-up and
guest mode. Recipes and folders have **no backend API yet**: `lib/api.js` keeps them in
memory, starts empty (no sample recipes), and loses them on reload, for logged-in users
and guests alike (a logged-in user just sees their username). Its functions
are async and shaped like the future endpoints, so swapping in real `fetch` calls later
won't touch the components. Folders are a flat list (no nesting or reordering).
Every recipe view shows a "Source" line: a clickable link (opens in a new tab) when the
recipe has a `link`, otherwise plain "Added manually" text. The link is not editable in the
UI; it will be filled by video import. 
## Layout

Marked (planned) = not built yet.

```
frontend/
├── app/
│   ├── layout.js          # Root layout: wraps everything in the Shell
│   ├── manifest.js        # Web app manifest (makes the site installable on Android)
│   ├── icon.png           # Favicon
│   ├── page.js            # Home: folders + recipes in the selected folder
│   ├── admin/page.js      # (planned) Admin: list, add, delete users (/admin)
│   └── recipe/
│       ├── page.js        # View one recipe        (/recipe?id=12)
│       ├── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
│       └── import/page.js # (planned) Paste a video link, compare, save (/recipe/import)
├── components/            # Shell (login screen or app), Auth (context), LoginScreen, Header, Language (context), FolderBar, RecipeCard, HeartButton, ConfirmDialog
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

## Login flow

- `Shell` wraps the app in `AuthProvider` (`components/Auth.js`), which asks the backend
  once on load who is logged in (`GET /api/auth/me`). Status is `loading`, `anonymous`,
  `guest` or `user`.
  - `user` or `guest` -> the app. `anonymous` -> `LoginScreen` shown in place of the page
    (no `/login` route), so after logging in the user is on the page they opened. If the
    backend can't be reached, the screen still offers "Continue as guest".
- `LoginScreen`: username and password, a Log in button, a switch to Sign up (same fields),
  and "Continue as guest". A wrong username or password shows one
  generic message (never which one was wrong). The login is remembered by cookie, so users
  see this screen only the first time on a device or after logging out.
- A thin bar under the header shows "Hello, <username>" and Log out; a guest sees "Guest"
  and a Log in button (back to the login screen).
- Every change of who is using the app (log in, sign up, log out, guest) clears the
  in-memory recipes, so one person's data never shows for the next.
- Auth cookies need the same origin as the API, so test login on the Worker (:8787, after
  `npm run build`); on `next dev` (:3000) there is no backend, so only guest mode works.
- Planned: any API call returning 401 (e.g. the admin deleted the user) sends the user to
  the login screen; `is_admin` shows the "Users" link and `acting_as` the "Acting as" banner.

## Screens

Built now: Login, Home, Recipe view, Edit. The rest are planned.

1. **Login / Sign up**: described above.
2. **Home**: folders with recipe counts. On phones only, they are one row of pills that
   scrolls sideways; on desktop, a side list with no scrolling;
   recipes of the selected folder as cards. Create, rename, and delete folders inline.
   Only an empty folder can be deleted (Delete looks disabled otherwise; tapping it shows a hint). Big "Add recipe" button. Each card has a
   heart to mark a favorite (once login exists, each user sees only their own folders, recipes, and favorites), and a "Favorites" toggle filters the list (combined with
   the selected folder).
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
7. **Users** (admin only): list of users, a form to add one (username and
   password), and per user an "Act as" button, a "Set password" button and a
   delete button (the last two with confirmation; deleting a user also deletes all their
   folders and recipes, and the dialog says so). Shows "N / 50 users".
   "Act as" opens Home showing that user's folders and recipes; every screen then works
   on their data, and a banner on every page says "Acting as <name>" with a "Stop"
   button that returns the admin to their own data.
8. **Change password** (planned): current password, new password, and Save. Reached
   from the header.

## UX rules

- Extremely simple: every action is reachable in 1-2 taps, with clear words on buttons
  (icons only alongside text).
- Mobile first: works from ~360px up, no horizontal scroll, large tap targets (≥ 44px).
- Every data screen handles loading, empty, error, and success states.
- Destructive actions ask for confirmation with `components/ConfirmDialog` (an in-page
  dialog). Don't use `window.confirm()`: some browsers and in-app views block it and it
  silently returns false.

## Bilingual (English / Hebrew)

- The app **always opens in Hebrew**, on every visit and reload; the choice is not
  remembered. A language toggle in the header switches both the UI strings and the
  recipe content shown for the rest of the visit. The toggle is disabled on the add/edit
  page (until Save or Cancel), and the form writes the recipe in that language only.
- Hebrew sets `<html lang="he" dir="rtl">`. Use CSS logical properties
  (`margin-inline-start`, `padding-inline`, `text-align: start`) so layouts flip correctly.
- UI strings live only in `lib/i18n.js`; never hard-code visible text in components.

## API client

Today `lib/api.js` is the in-memory data layer described above. The target design is:

- `lib/api.js` exports one function per endpoint (`login`, `getMe`, `getFolders`,
  `importRecipe`, ...) and throws an `Error` with the backend's message on failure.
- Every request uses `credentials: 'include'` so the session cookie is sent.
- Base URL is `process.env.NEXT_PUBLIC_API_BASE ?? ''`: empty in production (same
  origin), `http://localhost:8787` in local dev (set in `.env.local`).
