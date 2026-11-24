# Web UI

`frontend/`: a Next.js static export in plain JavaScript and CSS Modules, served by the Worker
([Architecture → Static export](./00_architecture.md#static-export)). The `frontend-ui` skill
has the coding rules (widths, tap targets, screen states, RTL, strings); this page keeps the
decisions behind the screens and the traps. Every action takes one or two taps, and buttons
carry words (icons only beside text).

## Data layer

`lib/api.js` is the only code that talks to the backend: one function per endpoint, all
same-origin (`/api/...`), so the session cookie goes along with no setup and there is no API
base URL. A failure throws `ApiError` with the backend's code (`network` when unreachable).

- **Guest mode** (`setGuestMode`): the tag and recipe functions use a fresh in-memory store
  instead. They trim and drop blank lines like the backend and make some of its checks with
  the same codes (`name_required`, `tag_exists`, `not_found`), but no length limits. Imports
  and AI tools throw `import_needs_login`, Browse `browse_needs_login`, without calling the
  backend. A guest's picture is kept as object URLs.
- `setLoggedOutHandler` is called on `not_logged_in`, which brings back the login screen
  ([Login flow](./03_auth.md#login-flow-in-the-frontend)).

## Screens and their rules

What each screen shows is in its component; these are the decisions behind them.

- **Home**: filter by tag (no nesting, no "new tag" or "delete tag": tags are added and
  removed on a recipe's page), Favorites, Search and sort. Search and sort run **in the
  browser** on the loaded recipes; search matches name, ingredients (both languages), author
  and tag names, every typed word. The sort choice isn't remembered. Calories, protein and
  the author show only on a recipe's own page, never on cards.
- **Add recipe** is a popup, not a route: one link field (it never asks which site), "Write
  it manually", and "Choose photos" (an `accept="image/*"` input with no `capture`, so a
  phone offers gallery, camera and files). A guest goes straight to the manual form. There is
  no model choice. While photos upload every button is disabled, so a double tap can't send
  them twice; the input is cleared after each pick so the same photos can be read again.
- **Import cards** sit on top of every tag view and aren't filtered by search. "Recipe ready"
  has its own card because a sorted list may not show the new recipe on top. `useImports`
  polls only while something runs and the page is visible.
- **Recipe view**: its "Source" is the link (opens in a new tab), "From a photo" or "Added
  manually". The link is filled only by an import and is never editable. Tags are changed right here, every tap saving at once, never in the edit
  form. The AI tools box (logged-in users only) shows every tool as a tile, so nothing has to
  be discovered; tools read the text the page shows and save at once, asking first when they
  would overwrite text or numbers. "Scan the link again" asks first (it replaces edits) and
  holds the only model choice, "Use the best model", ticked while `models.bestAvailable`.
  Calories and protein carry a note that AI calculated them.
- **Edit** writes one language at a time, the app's current one; the other is kept as is.
  The author and the calories and protein are the same in both languages. Public/private and
  the picture only change the form until Save. No AI tools here, so it stays a plain form.
- **Browse** (logged-in users only, `/browse`): two big tabs switch between "My recipes" and
  "From others". It loads by itself as the user scrolls (`IntersectionObserver`), with a
  "Show more" button too. While a search matches few, more pages keep loading until enough
  match. "Save a copy" saves at once, with no question: a copy is easy to delete.
- **My account** is a popup from the name in the header. No old password and no typing the
  new one twice (the owner's choice); it asks before saving. The admin also sees "Log in as
  another user" ([Login → Admin](./03_auth.md#admin-login-as-a-user)).
- **Recently deleted** is a popup from a quiet button at the end of Home, shown only while
  there is something to restore. A guest has no bin: their delete is final, and the
  confirmation says so.

## Share

The installed app is in Android's Share menu (`share_target` in `app/manifest.js`). Sharing a
post, a web page, or 1 to 7 photos opens `/share`, which imports **at once, with no
question**, then closes the app so Android returns to the app the user shared from.

- The share is a multipart POST (only a POST carries files), which a static page can't read,
  so `public/sw.js` receives it: a link opens `/share` with the shared text in the query;
  photos wait in the `shared-photos` cache and open `/share?photos=<count>`, where
  `takeSharedPhotos()` reads and deletes them.
- `findSharedLink()` takes the first link from the text (Android puts it in `text`, often
  with words around it). The page then clears its query (`replaceState`), so reopening it
  never imports twice.
- Photos go through the same `importPhotos()` as "Choose photos", and the page waits until
  the photos and the recipe's picture are sent, since closing the app would stop the picture.
- `window.close()` works only while `/share` is the window's only history entry (the
  browser's rule), which is how a share opens a closed app. Every outcome also offers to go
  back and to open the recipes (`router.replace`, so Back never lands on `/share`). A failure
  never closes by itself.
- Logged out: the login screen first, then the import goes on (shared photos wait in the
  cache). A guest is told to log in.
- Only Chromium browsers on Android, once the site is installed; nothing on iPhone. An app
  installed before a manifest change picks it up when Chrome refreshes the manifest (about
  daily), or at once after reinstalling.

## PWA

`app/manifest.js` and `public/sw.js` (registered in production only) make the site
installable. The service worker caches no pages; it only receives shares. Needs HTTPS.

## UX rules

- A failed load shows its reason and "Try again"; a failed form stays filled in with the
  message under it. The favorite heart changes at once and changes back with a message if
  saving failed.
- **Confirm with `components/ConfirmDialog`**, never `window.confirm()`: some browsers and
  in-app views block it and it silently returns false.
- **Swipe back**: wherever a Back link shows (`components/BackLink`), a quick sideways swipe
  does the same (`lib/swipe.js`). It is ignored when it starts in a field, a sideways-scrolling
  row or a popup, while zoomed in, and with two fingers. The edit form has no swipe, so a slip
  never drops what was typed. On phones, Home and Browse also switch with a sideways swipe;
  both open scrolled just past the tabs.

## English and Hebrew

- The app **always opens in Hebrew**; the choice is not remembered. The header's toggle
  switches the UI and the recipe text shown, and is disabled on the edit page until Save or
  Cancel.
- Hebrew sets `<html lang="he" dir="rtl">`, and a swipe's direction is mirrored.
- A recipe with one language empty shows the other with a "not written yet" note.
- A model sometimes slips a third language into a recipe (Russian words in Hebrew text). When
  the shown text has a letter outside the Latin and Hebrew scripts, a note at the top of the
  recipe (logged-in users only, since the fixes are AI tools) suggests switching to the other
  language and translating from it, offered only when that version exists and is clean, and
  scanning the link again, offered only for an imported recipe. With neither, no note.

## Known gaps and accepted trade-offs

- Sharing to the app returns to the source app only when the app wasn't already open;
  otherwise Chrome may load the share into the open app, which can't close, and the page tells
  the user to tap Back.
- `ConfirmDialog` asks for focus on Cancel with `autoFocus`, but `showModal()` then moves it to
  the first button, the confirm one, so Enter confirms.
- **Prefetch 404s in Windows builds**: the console shows 404s for files like
  `recipe/__next.recipe.__PAGE__.txt`. Next's export names them with `path.relative()`, which
  uses `\` on Windows, so they land in subfolders the browser never asks for. Navigation still
  works (Next falls back to the page's full data file) and production builds on Linux. Don't
  turn off prefetching or rename files to work around it.
- A HEIC photo the browser can't draw gives the recipe no picture ([Pictures](./07_pictures.md#known-gaps-and-accepted-trade-offs)).
- The third-language note on a recipe goes by script only, so another language written in
  Latin letters (Spanish words in the English text) doesn't bring it up.
