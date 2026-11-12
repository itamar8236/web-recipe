# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's API (see `backend/README.md`). Read the root `AGENTS.md` first.

## Current state

The recipe browsing and manual add/edit/delete screens exist, plus login, sign-up, guest
mode and creating a recipe from a YouTube link. A logged-in user's folders, recipes and favorites are loaded from and saved
to the backend (D1). A **guest's** live only in memory in `lib/api.js`: nothing is sent
to the backend, the app starts empty and everything is gone on reload. Components call
the same `lib/api.js` functions in both modes. Folders are a flat list (no nesting or
reordering).
Every recipe view shows a "Source" line: a clickable link (opens in a new tab) when the
recipe has a `link`, otherwise plain "Added manually" text. The link is not editable in the
UI; it is filled by video import.

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
│       └── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
├── components/            # Shell (login screen or app), Auth (context), LoginScreen, Header, AccountDialog, Language (context), FolderBar, SearchBox, RecipeCard, HeartButton, ConfirmDialog, ImportDialog, ImportCards
├── public/                # sw.js (minimal service worker, caches nothing), icons/ (app icons)
├── lib/
│   ├── api.js             # The only data layer: the backend for users, memory for guests
│   ├── api.test.js        # Vitest tests for api.js and i18n helpers
│   ├── i18n.js            # UI strings in en/he + pickLanguage()
│   ├── search.js          # matchesSearch(): recipe name/ingredient search
│   └── search.test.js     # Vitest tests for search.js
├── styles/globals.css     # Design tokens (CSS variables), buttons, form fields
└── next.config.mjs
```

- **Installable (PWA):** `app/manifest.js` + `public/sw.js` (registered in production only) let
  Chrome on Android offer "Install app". Icons are cropped from the Recipe Rocket logo into
  `public/icons/`. Needs HTTPS (fine on Cloudflare); it doesn't work on plain `http://` hosts.
- Static export can't use dynamic route segments without a build-time list, so recipe
  pages take the id as a **query parameter** and fetch on the client.
- Components are client components where they fetch or hold state; keep it simple.
- **Known, harmless: prefetch 404s in Windows builds.** On a build made on Windows, the
  browser console shows 404s for files like `recipe/__next.recipe.__PAGE__.txt`. Next
  16.4.5's export names those prefetch files from `path.relative()`, which uses `\` on
  Windows, and then only turns `/` into `.`, so the files land in subfolders the browser
  never asks for. Navigation still works (Next falls back to the page's full data file).
  Production builds on Linux (Workers Builds), where the names come out right. Leave it
  as is: don't turn off prefetching or rename files to work around it.

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
- A thin bar under the header shows "Hello, <username>" (with a person icon; tapping it
  opens "My account") and Log out; a guest sees "Guest"
  and a Log in button (back to the login screen).
- Every change of who is using the app (log in, sign up, log out, guest) tells `lib/api.js`
  whether this is a guest (`setGuestMode`) and empties the guest's in-memory data, so one
  person's data never shows for the next.
- A folders/recipes request that answers 401 (e.g. the admin deleted the user) brings back
  the login screen.
- Auth cookies need the same origin as the API, so test login on the Worker (:8787, after
  `npm run build`); on `next dev` (:3000) there is no backend, so only guest mode works.
- Planned: `is_admin` shows the "Users" link and `acting_as` the "Acting as" banner.

## Screens

Built now: Login, Home (with the import dialog and cards), Recipe view, Edit, My account.
The rest are planned.

1. **Login / Sign up**: described above.
2. **Home**: folders with recipe counts. On phones only, they are one row of pills that
   scrolls sideways; on desktop, a side list with no scrolling;
   recipes of the selected folder as cards. Create, rename, and delete folders inline.
   Only an empty folder can be deleted (Delete looks disabled otherwise; tapping it shows a hint). Big "Add recipe" button. Each card has a
   heart to mark a favorite (each user sees only their own folders, recipes, and favorites), and a "Favorites" toggle filters the list (combined with
   the selected folder). A small "Search" button above the folders opens a search box
   (× or leaving it empty closes it again) that filters the cards while typing, by recipe
   name or ingredients in both languages (every typed word must match), combined with the
   selected folder and "Favorites". It runs in the browser on the loaded recipes.
3. **Add recipe** (`components/ImportDialog`, a popup, no route): "+ Add recipe" opens it
   for a logged-in user. A guest goes straight to the manual form, since importing needs
   an account. One focused link field; it asks only for the link, never the site.
   - **Import** submits it: the dialog closes and a card shows at once.
   - **"Write it manually"** opens the manual form (`/recipe/edit`, keeping the selected
     folder). The manual form's Cancel returns to Home.
   - **×**, **Escape** and **tapping outside** close the dialog and stay on Home.
   - An invalid or unsupported link keeps the dialog open with the error under the field.
   - A small "Model" choice, Best (default) or Basic, picks the model for this import.
   - It shows "Best-model imports left today: N", and "Using the basic model until <time>"
     while on the basic model.
   - If the best model is out and the user hasn't approved the basic one, it asks, with
     "Use basic model" (sends the link again with the approval) and "Not now" (keeps the
     link in the field).
4. **Import cards** (`components/ImportCards`, at the top of the content section, in every
   folder view, not filtered by search):
   - Running: gray with a gentle pulse, the title or link, and "Getting the video
     details..." or "Reading the recipe...".
   - Ready: "Recipe ready: <name>" with Open (which also dismisses) and ×. Needed because
     the recipe list is oldest-first.
   - Failed: red, the message, Retry when it can help, ×.
   - Needs approval: says when the best model is back, with "Use basic model" and ×. A
     Retry that finds the best model out turns its card into this one.
   - `useImports` polls every 4 s only while something is running and the page is visible,
     and at once when the page becomes visible. A card turning ready reloads the recipes.
5. **Recipe view**: name, source link (opens the video), ingredients, steps. Heart, Edit
   and Delete buttons (delete asks for confirmation). A recipe made by the basic model also
   shows "Re-run with best model" while that model is available: it asks with
   `ConfirmDialog` first, because it replaces the recipe's text including any edits, then
   returns to Home, where the usual card shows.
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
8. **My account** (`components/AccountDialog`, a popup): opened by tapping the name in
   the header. Username (filled in) and New password (empty = keep it), then Save, which
   asks "Save the changes to your account?" first. No old password and no typing the new
   one twice (the owner's choice). The user stays logged in everywhere after a
   change. Saving with nothing changed shows a hint instead.

## UX rules

- Extremely simple: every action is reachable in 1-2 taps, with clear words on buttons
  (icons only alongside text).
- Mobile first: works from ~360px up, no horizontal scroll, large tap targets (≥ 44px).
- Every data screen handles loading, empty, error, and success states. Built so far:
  - Loading shows "Loading..."; a failed load shows the reason and a "Try again" button.
  - While a save runs its button is disabled and reads "Saving..." / "Deleting...";
    on failure the form stays filled in and the message shows under it.
  - The favorite heart changes at once, is disabled until the backend answers, and
    changes back with a message if saving failed.
- Destructive actions ask for confirmation with `components/ConfirmDialog` (an in-page
  dialog). Don't use `window.confirm()`: some browsers and in-app views block it and it
  silently returns false. Known, not fixed: it asks for focus on Cancel with `autoFocus`, but
  `showModal()` then moves focus to the first button, the confirm one, so Enter confirms.

## Bilingual (English / Hebrew)

- The app **always opens in Hebrew**, on every visit and reload; the choice is not
  remembered. A language toggle in the header switches both the UI strings and the
  recipe content shown for the rest of the visit. The toggle is disabled on the add/edit
  page (until Save or Cancel), and the form writes the recipe in that language only.
- Hebrew sets `<html lang="he" dir="rtl">`. Use CSS logical properties
  (`margin-inline-start`, `padding-inline`, `text-align: start`) so layouts flip correctly.
- UI strings live only in `lib/i18n.js`; never hard-code visible text in components.

## API client

`lib/api.js` exports one function per endpoint: auth (`getMe`, `login`, `register`, `updateAccount`,
`logout`), folders (`getFolders`, `createFolder`, `renameFolder`, `deleteFolder`),
recipes (`getRecipes`, `getRecipe`, `saveRecipe`, `setFavorite`, `deleteRecipe`) and imports
(`getImports`, `startImport`, `retryImport`, `dismissImport`, `rerunRecipe`). For a
guest the folder and recipe functions use memory instead, with the same checks and error
codes as the backend, and the import functions throw `import_needs_login` without calling
the backend.

- Requests go to the same origin (`/api/...`), so the session cookie is sent without any
  extra setup. There is no API base URL or CORS: test anything that needs the backend on
  the Worker (:8787).
- On failure it throws `ApiError` with the backend's `error` code (`network` if the
  backend can't be reached); `errorMessage()` in `lib/i18n.js` turns the code into text.
