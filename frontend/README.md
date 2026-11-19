# Frontend

Next.js app (App Router) in plain JavaScript and CSS Modules, built as a **static export**
(`output: 'export'` → `out/`) that the backend Worker serves. All data comes from the
backend's API (see `backend/README.md`). Read the root `AGENTS.md` first.

## Current state

The recipe browsing and manual add/edit/delete screens exist, plus login, sign-up, guest
mode and creating a recipe from a YouTube, Facebook or Instagram link, a recipe web page or a photo of a written recipe. A logged-in user's tags, recipes and favorites are loaded from and saved
to the backend (D1). A **guest's** live only in memory in `lib/api.js`: nothing is sent
to the backend, the app starts empty and everything is gone on reload. Components call
the same `lib/api.js` functions in both modes. Tags are a flat list (no nesting or
reordering), and a recipe has any number of them.
Every recipe view shows a "Source" line: a clickable link (opens in a new tab) when the
recipe has a `link`, "From a photo" when it was read from a photo (`fromPhoto`), otherwise
plain "Added manually" text. The link is not editable in the UI; it is filled by import.

## Layout

```
frontend/
├── app/
│   ├── layout.js          # Root layout: wraps everything in the Shell
│   ├── manifest.js        # Web app manifest (makes the site installable on Android)
│   ├── icon.png           # Favicon
│   ├── page.js            # Home: tags + recipes with the selected tag
│   ├── browse/page.js     # Browse: other users' public recipes (/browse)
│   ├── share/page.js      # Where Android's Share menu sends a link (/share?text=...)
│   └── recipe/
│       ├── page.js        # View one recipe        (/recipe?id=12)
│       └── edit/page.js   # Create / edit a recipe (/recipe/edit?id=12, no id = new)
├── components/            # Shell (login screen or app), Auth (context), LoginScreen, Header, AccountDialog, ImpersonateSection, Language (context), ModeTabs, BrowseCard, TagBar, RecipeTags, SearchBox, SortMenu, RecipeCard, HeartButton, ConfirmDialog, ImportDialog, ImportCards, RecipeAiTools, SubstituteDialog
├── public/                # sw.js (minimal service worker, caches nothing), icons/ (app icons)
├── lib/
│   ├── api.js             # The only data layer: the backend for users, memory for guests
│   ├── api.test.js        # Vitest tests for api.js and i18n helpers
│   ├── i18n.js            # UI strings in en/he + pickLanguage()
│   ├── recipeForm.js      # Edit form text <-> api lines
│   ├── recipeForm.test.js # Vitest tests for recipeForm.js
│   ├── search.js          # matchesSearch(): recipe name/ingredient/tag search
│   ├── sort.js            # SORTS, sortRecipes(): the orders the lists can be sorted in
│   ├── sort.test.js       # Vitest tests for sort.js
│   ├── photo.js           # preparePhoto(): a chosen picture, ready to send
│   ├── photo.test.js      # Vitest tests for photo.js
│   ├── share.js           # findSharedLink(): the link in what Android shared
│   ├── share.test.js      # Vitest tests for share.js
│   └── search.test.js     # Vitest tests for search.js
├── styles/globals.css     # Design tokens (CSS variables), buttons, form fields
└── next.config.mjs
```

- **Installable (PWA):** `app/manifest.js` + `public/sw.js` (registered in production only) let
  Chrome on Android offer "Install app". The manifest's `share_target` puts the installed
  app in Android's Share menu (see Screens → Share). Icons are cropped from the Recipe Rocket logo into
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
  once on load who is logged in (`GET /api/auth/me`). Status is `loading`, `error`,
  `anonymous`, `guest` or `user`.
  - `user` or `guest` -> the app. `anonymous` (the backend answered 401) -> `LoginScreen`
    shown in place of the page (no `/login` route), so after logging in the user is on the
    page they opened.
  - `error` (any other failure: offline, a server error, or `next dev` with no backend) ->
    "Could not check whether you are logged in." with the reason, a "Try again" button that
    asks again, and "Continue as guest". It never shows the login screen, since the user
    may well be logged in.
- `LoginScreen`: username and password, a Log in button, a switch to Sign up (same fields),
  and "Continue as guest". A wrong username or password shows one
  generic message (never which one was wrong). The login is remembered by cookie, so users
  see this screen only the first time on a device or after logging out.
- A thin bar under the header shows "Hello, <username>" (with a person icon; tapping it
  opens "My account") and Log out; a guest sees "Guest"
  and a Log in button (back to the login screen). If Log out fails (e.g. offline), the user
  stays logged in and a line under the bar says "You are still logged in." with the reason.
- Every change of who is using the app (log in, sign up, log out, guest) tells `lib/api.js`
  whether this is a guest (`setGuestMode`) and empties the guest's in-memory data, so one
  person's data never shows for the next.
- A tags/recipes request that answers 401 (the session is gone) brings back the login
  screen.
- Auth cookies need the same origin as the API, so test login on the Worker (:8787, after
  `npm run build`); on `next dev` (:3000) there is no backend, so only guest mode works.

## Screens

1. **Login / Sign up**: described above.
2. **Home**: tags with recipe counts (`components/TagBar`), which filter the list. On
   phones only, they are one row of pills that scrolls sideways; on desktop, a side list
   with no scrolling; recipes with the selected tag as cards, each showing all its tags.
   "No tags" shows only while some recipe has none. The selected tag can be renamed
   inline; there is no "new tag" or "delete tag" here: tags are added and removed on each
   recipe's page, and a tag no recipe has is gone. Big "Add recipe" button. Each card has a
   heart to mark a favorite (each user sees only their own tags, recipes, and favorites), and a "Favorites" toggle filters the list (combined with
   the selected tag). A small "Search" button above the tags opens a search box
   (× or leaving it empty closes it again) that filters the cards while typing, by recipe
   name, ingredients (both languages) or tag names (every typed word must match),
   combined with the selected tag and "Favorites". It runs in the browser on the loaded
   recipes.
   Beside Search, a small **sort** dropdown (`components/SortMenu`, a native `<select>`)
   shows "Newest first", the usual order; it can switch to oldest first, most protein,
   most calories or fewest calories (`lib/sort.js`, in the browser; a recipe with no
   calories or protein goes last). The choice is not remembered.
3. **Add recipe** (`components/ImportDialog`, a popup, no route): "+ Add recipe" opens it
   for a logged-in user. A guest goes straight to the manual form, since importing needs
   an account. One focused link field ("A video, a post or a recipe page"); it asks only
   for the link, never the site.
   - **Import** submits it: the dialog closes and a card shows at once.
   - **"Write it manually"** opens the manual form (`/recipe/edit`). The manual form's
     Cancel returns to Home.
   - **×**, **Escape** and **tapping outside** close the dialog and stay on Home.
   - An invalid or unsupported link keeps the dialog open with the error under the field.
   - There is no model choice: the backend picks the models.
   - **"📷 Choose a photo"**, a full-width button under them, opens a hidden
     `<input type="file" accept="image/*">` with no `capture`, so the phone offers its
     gallery, camera and files (iPhone: Photo Library, Take Photo, Choose File; a computer:
     the file picker). One picture of a written recipe; it is uploaded at once
     (`preparePhoto` in `lib/photo.js` sends anything up to 15 MB unchanged and shrinks
     only a bigger one to 4096 px, JPEG 0.92). While it uploads the dialog stays open,
     the button says "Uploading the photo..." and every button is disabled, so a double tap
     can't send it twice; then the dialog closes and its card shows. The input is cleared
     after each pick, so the same picture can be chosen again for a second read. Errors
     (`photo_invalid`, `photo_too_big`, `photo_upload_failed`, `quota`, ...) show under the
     field, like a link's. Photos always use the best model first; there is no checkbox.
4. **Import cards** (`components/ImportCards`, at the top of the content section, in every
   tag view, not filtered by search):
   - Running: gray with a gentle pulse, the title or link, and "Getting the
     details...", "Getting the video..." (Facebook and Instagram, whose video is handed to
     the model as a file) or "Reading the recipe..." (`stageMessage` in `lib/i18n.js`).
     A photo's card is titled "A photo" until the recipe has a name, and says "Reading the
     photo..." at every stage.
   - Ready: "Recipe ready: <name>" with Open (which also dismisses) and ×. Needed because
     the list may be sorted so the new recipe isn't on top.
   - Failed: red, the message, Retry when it can help, ×. Retry starts a new import (a new
     card id) and the failed card is replaced by it.
   - `useImports` polls every 4 s only while something is running and the page is visible,
     and at once when the page becomes visible. A card turning ready reloads the recipes.
5. **Recipe view**: name, source link (opens the video or page; "From a photo" for a photo), tags, ingredients, steps, then a
   "Per serving" card with calories and protein (only when the recipe has either) and a small note that they were calculated by AI and may be inaccurate, then the
   AI tools box (logged-in users only, below), then Edit and Delete buttons (delete asks
   for confirmation). The heart is beside the name. Calories and protein show only here,
   never on the Home or Browse cards.
   - **Tags** (`components/RecipeTags`) are changed right here, not on the edit form, and
     every tap saves at once. Each tag is a chip with an ×: tapping it removes the tag.
     "+ Add tag" opens a small panel with the user's other tags (tap one to add it), a
     field for a new tag, and Done. A new recipe has no tags until they are added here.
   - **AI tools** (`components/RecipeAiTools`, a "✨ AI tools" box at the bottom, logged-in
     users only). Every tool is always shown as a tile (an icon, a bold title and a one-line
     hint; one column on phones, two side by side when there is room), so nothing has to be
     opened or discovered. They all read the text the page shows (the app's language, or the
     other one when the app's has none yet). The backend picks the models; the one choice
     is in the scan's confirmation.
   - **"Substitute an ingredient" / "החלפת מצרך"** (needs an ingredient) opens a popup
     (`components/SubstituteDialog`) listing the recipe's ingredients as big buttons. Tapping
     one asks the model at once: three pulsing dots show under the chosen ingredient while
     it works (only Close is offered then), then up to 4 substitutes, written in the app's
     language: what to use, how much, and a short note, with a "Suggested by AI" hint. "No
     good substitute" when the model finds none. "Choose another ingredient" (once there is
     an answer or an error) goes back to the list. Nothing is saved: the answer is gone when
     the popup closes.
   - **"Translate to Hebrew" / "Translate to English"** (and the Hebrew labels) translates
     the shown language into the other one and saves the recipe at once, updating the page.
     When the app's language has no text yet, that is the language it translates into. It
     asks first ("... and save the recipe?") if the other language already has text.
   - **"Calculate calories and protein" / "חישוב קלוריות וחלבון"** estimates both per
     serving from the shown text (it needs an ingredient) and saves them at once, so the
     "Per serving" card appears or changes. It asks first if either already has a value.
   - **"Scan the link again"** (only for a recipe with a link) asks first, because it
     replaces the recipe's text including edits, then starts it like a new import and
     returns to Home, where its card shows. The confirmation holds the checkbox "Use the best
     model (slower, up to 5 a day)" (for the admin, who has no limit of 5, just "(slower)"), off by default, so it is clearly about the scan alone;
     when that model can't be used the scan goes on with the usual models by itself, and
     nothing asks for approval.
   - While one tool runs its tile's hint says so ("Translating...") and the other tiles are
     held; a failure shows its error under the tiles, and nothing is saved then.
6. **Edit**: name, ingredients, and steps (one per line) in the app's current language,
   plus two optional number fields, calories (kcal) and protein (g) per serving, which are
   the same in both languages (empty = not known).
   Tags are not here (see Recipe view). A short note explains that to write the other language you
   save, switch the language, and tap Edit; the other language's text is kept as is. A name in at least one
   language is required. If a language is left empty, the recipe view shows the other
   language with a "not written yet" note.
   - **Public or private** (logged-in users only): a box saying which it is, with its
     explanation and a "Make private" / "Make public" button. The button only changes the
     form; Save stores it, and Cancel leaves it as it was. A new recipe starts with the
     user's "New recipes are public" default.
   - No AI tools here: they are on the recipe view, so the form stays a plain form.
7. **Browse** (`/browse`, logged-in users only): reached with the two big tabs at the top
   of Home and Browse (`components/ModeTabs`: "My recipes" / "From others"; a guest never
   sees them, and `/browse` tells a guest to log in).
   - **On phones** (under 760px) the tabs are a secondary control. Both pages open scrolled
     just past them, so the content (on Home, the Search button) is at the top and
     scrolling up shows the tabs. A sideways swipe anywhere on the page switches between
     the two: in English a swipe to the left opens "From others" and to the right goes
     back; Hebrew is mirrored. A drag that starts on the tag pills (they scroll sideways)
     or in a text field, or that is mostly vertical, doesn't switch. On desktop the tabs
     are simply at the top and there is no swipe.
   - Other users' public recipes in a random order, 10 at a time. The next page loads by
     itself when the end of the list comes within 600px of the screen
     (`IntersectionObserver`); the "Show more" button at the end does the same by hand.
     Each visit gets a new order. The end says "You have seen them all."
   - The same sort dropdown as on Home, beside Search, starts on "Random order" and offers
     the same five orders; picking one reloads the list from the top in that order (the
     backend sorts, since the list comes a page at a time).
   - The same "Search" button as on Home sits above the title and searches name,
     ingredients and tags the same way, on the recipes loaded so far. While few match,
     the end of the list stays near the screen, so more pages keep loading by themselves
     until enough match or there are no more (then "No recipes found." if none did).
   - Each card (`components/BrowseCard`) shows the name, "Saved by <username>", the tags,
     the ingredient count and the source link, with two buttons side by side: **Show
     recipe** opens the ingredients and steps inside the card, and **+ Save a copy** saves
     the user's own copy at once (no question: it is easy to delete). The button then
     becomes "✓ Saved to your recipes" with an Open link to the copy.
   - A recipe the user already saved still shows, on a later visit with the Save button again.
   - On the **recipe view**, a logged-in user sees a small "Public" or "🔒 Private" label
     next to the source link, nothing more; it is changed in the edit form. A private
     recipe's card on Home has a "🔒 Private" label.
8. **My account** (`components/AccountDialog`, a popup): opened by tapping the name in
   the header. Username (filled in) and New password (empty = keep it), then Save, which
   asks "Save the changes to your account?" first. No old password and no typing the new
   one twice (the owner's choice). The user stays logged in everywhere after a
   change. Saving with nothing changed shows a hint instead. Under them, "My defaults" has
   two checkboxes saved with the same Save: "New recipes are public" and "Copy the tags
   too when I save someone else's recipe".
   The admin (only) also sees "Log in as another user" under them
   (`components/ImpersonateSection`): a list of every other username, A to Z, and "Log in
   as this user", which asks first and then reloads the app as that user (a full reload,
   so no screen keeps the admin's data). That user has no admin section, so to come back
   the admin logs out and logs in as themself.

9. **Share** (`/share`, no link to it in the app): where Android's Share menu opens the
   installed app (`share_target` in `app/manifest.js`, method GET, so `sw.js` is
   unchanged). Sharing a YouTube, Facebook or Instagram post, or a web page from Chrome,
   to "Recipes" opens it with the shared text in `title`/`text`/`url`.
   - It takes the first link out of that text (`lib/share.js`: Android puts the link in
     `text`, often with words around it) and starts the import at once, with no question,
     like "Import" in the Add recipe dialog. It then clears the query (`replaceState`), so
     reopening the page never imports twice.
   - Started: "Importing the recipe..." for 1.5 s, then the page calls `window.close()`,
     which closes the app and returns Android to the app the user shared from, like
     sharing to a chat app. The import goes on in the background; its card shows on Home.
   - Closing works only while `/share` is the window's only history entry (the browser's
     rule), which is how a share opens a closed app. If the app was already open, Chrome
     may load the share into it instead and refuse to close: the page then says to use
     the phone's Back button. Every outcome also has "Back to the app I came from" (the
     same close) and "Open my recipes" (`router.replace`, so Back doesn't land on `/share`).
   - Failed (an unsupported link, already imported, the quota...): the usual import error
     message and the two buttons; it doesn't close by itself. No link: "No link was
     shared." Logged out: the login screen first (in place, like every page), then the
     import goes on; a guest gets "Log in to add a recipe from a link".
   - Only Chrome (and other Chromium browsers) on Android, and only once the site is
     installed as an app; nothing on iPhone. An app installed before this change gets the
     Share entry when Chrome next refreshes its manifest (about once a day, when the app is
     opened), or at once by uninstalling and installing it again.

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
`logout`), tags (`getTags`, `renameTag`),
recipes (`getRecipes`, `getRecipe`, `saveRecipe`, `setRecipeTags`, `setFavorite`, `setRecipePublic`, `deleteRecipe`), browse (`getBrowse`, `copyRecipe`, `newBrowseSeed`) and imports
(`getImports`, `startImport`, `startPhotoImport` (the picture as the body, with its own
`Content-Type`), `retryImport`, `dismissImport`, `rerunRecipe`) and
`translateRecipe`, `estimateNutrition`, `suggestSubstitutes`. For a guest the tag and recipe functions use memory instead. They
trim names and lines and drop blank lines like the backend, and make only some of its
checks, with the same codes: `name_required` (a tag, or a recipe with no name in either
language), `tag_exists`, and `not_found` for renaming a missing tag or setting a
missing recipe's tags or favorite. There are no length limits (`too_long`); deleting a
missing item does nothing, and `getRecipe` returns `null`.
The import and AI-tool functions throw `import_needs_login` without calling the backend,
and the browse functions `browse_needs_login`.

- Requests go to the same origin (`/api/...`), so the session cookie is sent without any
  extra setup. There is no API base URL or CORS: test anything that needs the backend on
  the Worker (:8787).
- On failure it throws `ApiError` with the backend's `error` code (`network` if the
  backend can't be reached); `errorMessage()` in `lib/i18n.js` turns the code into text.
