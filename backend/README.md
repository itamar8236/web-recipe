# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
YouTube, Facebook and Instagram links, recipe web pages and photos of written recipes into recipes, and serves the frontend's static build. Read the root
`AGENTS.md` first.

Record new files, schema and endpoints here in the same PR that adds them.

## Overview

The Worker (`src/index.js`) runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`);
everything else is the static build from `../frontend/out`, served by Cloudflare. It runs
on the Workers runtime with no `nodejs_compat` flag, so use web APIs, never `node:*`
modules (the scripts in `scripts/` run on Node). Run it locally as the `local-dev` skill
says. Production is deployed only by merging a PR into `main`, through Workers Builds
(root directory `/`), which builds with
`cd frontend && npm install && npm run build` and then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production).
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a
  Worker Preview that doesn't replace the production Worker, but shares its database
  (see [Database](#database)). It needs the `previews` block in
  `wrangler.jsonc`.

Code: `src/index.js` (routes, auth and the daily cron job), `src/data.js` (tags and recipes), `src/deleted.js`
("Recently deleted": restoring and the 30-day purge), `src/browse.js`
(other users' public recipes), `src/pictures.js` (recipes' pictures: the only file that
touches picture bytes),
`src/imports.js` (import endpoints; the import itself is in [`IMPORT.md`](IMPORT.md)), `src/translate.js` (translation), `src/nutrition.js` (calories estimate), `src/substitute.js` (ingredient substitutes), `src/http.js` (JSON helpers), `src/session.js`
(cookies and the `sessions` table), `src/password.js` (PBKDF2), and `src/import/`:
`workflow.js` (the background job), `stages.js` (what each stage does), `models.js` (model
choice, usage counting, reset time), `llm.js` (the only file that knows
Gemini's format, including its file store for videos and photos), `groq.js` (the only file that knows
Groq's format, for the fallback model), `errors.js`, and `sources/` (link detection and one
adapter per site: `youtube.js`, `facebook.js`, `instagram.js`, with `meta.js` for what the
last two share, `web.js` for any other web page, and `photo.js` for an uploaded photo, which
is never matched against a link). `scripts/e2e-links.mjs` runs real imports through the local app by hand. Tests: `npm test` (`test/`, Vitest in the Workers runtime on a
throwaway local D1 built from `schema.sql`; never touches production or `.wrangler/state`).
Lint: `npm run lint` (ESLint, `eslint.config.mjs`).

## Auth API

JSON in and out; sign-up and login require `Content-Type: application/json` (so another
site's plain HTML form can't log a visitor in). Errors are `{ "error": "<code>" }`. Everything under `/api/*` needs a
session except the three public auth endpoints; unknown paths are 404 when logged in.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/auth/register` `{username, password}` | Create a user (never admin) and log in | 201 `{user}` | 400 `username_invalid` (1-50 chars after trimming), 400 `password_invalid` (1-200 chars), 400 `invalid_request`, 409 `username_taken` (case-insensitive), 403 `user_limit` (50 users) |
| `POST /api/auth/login` `{username, password}` | Log in on this device | 200 `{user}` | 400 `invalid_request`, 401 `invalid_credentials` (same for wrong password and unknown user) |
| `POST /api/auth/logout` | Delete this device's session | 200 `{ok}` | none (works without a session) |
| `GET /api/auth/me` | Who is logged in | 200 `{user}` | 401 `not_logged_in` |
| `PUT /api/auth/me` `{username?, password?, defaultPublic?, copyTags?}` | Change your own username, password and/or defaults (at least one; the old password is not asked for). Every existing login stays, on this device and the others | 200 `{user}` | 400 `invalid_request` (also a default that isn't `true`/`false`), `username_invalid`, `password_invalid` (same limits as sign-up), 409 `username_taken`, 401 `not_logged_in` |
| `GET /api/admin/users` | Admin only: everyone else, to log in as | 200 `{users: [{id, username}]}`, A to Z | 403 `not_admin`, 401 `not_logged_in` |
| `POST /api/admin/impersonate` `{userId}` | Admin only: log this device in as that user, no password | 200 `{user}` (that user) | 400 `invalid_request`, 404 `not_found` (no such user, or the admin), 403 `not_admin`, 401 `not_logged_in` |

`user` is `{ id, username, is_admin, defaultPublic, copyTags }`. The last two are the user's
defaults, both `true` for a new user: a recipe they add (manually, by import or by copying)
starts public, and copying a recipe in Browse copies its tags too. Cookies (both HttpOnly, SameSite=Lax, 10 years,
`Secure` on https): `device` (random id, kept across logouts) and `session` (random
secret; only its SHA-256 is stored in `sessions.token_hash`). Login upserts the row for the
device. There is no login rate limit, and a password may be 1 character: accepted by the
owner (`AGENTS.md` → Known bugs and accepted trade-offs).

**Admin login as a user**: `POST /api/admin/impersonate` sets `sessions.acting_as_user_id`
on this device's row (the schema's triggers refuse it for anyone but the admin). From then
on `getSessionUser` returns that user for everything: `GET/PUT /api/auth/me`, tags,
recipes, Browse, imports and the model caps, exactly as if they had logged in; `user_id`
stays the admin, so the row still says who really logged in. The user is never the admin,
so the admin endpoints answer 403 until the device logs out. Logging out deletes the row,
and the next login starts with `acting_as_user_id` NULL. Usernames are unique
(case-insensitive), so the list never shows two the same.

## Tags and recipes API

All need a session (401 `not_logged_in` otherwise) and work only on the logged-in user's
data (the session's user, or the user the admin logged in as; see Auth API). Another user's tag or recipe
answers 404, exactly like one that doesn't exist. Bodies must be JSON with
`Content-Type: application/json` (400 `invalid_request` otherwise). A path that exists
with the wrong method answers 405 `method_not_allowed`.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/tags` | The user's tags, oldest first | 200 `{tags: [{id, name}]}` | |
| `PUT /api/tags/:id` `{name}` | Rename a tag | 200 `{tag}` | 400 `name_required`, `too_long` (> 100 chars), 409 `tag_exists` (another tag has that name), 404 `not_found` |
| `GET /api/recipes` | All the user's recipes, oldest first | 200 `{recipes: [recipe]}` | |
| `GET /api/recipes/:id` | One recipe | 200 `{recipe}` | 404 |
| `POST /api/recipes` `{en, he, calories?, protein?, author?}` | Create a manual recipe, with no tags | 201 `{recipe}` | 400 `name_required` (no name in either language), `too_long`, `invalid_nutrition`, `invalid_request` |
| `PUT /api/recipes/:id` `{en, he, calories?, protein?, author?}` | Replace its text, and the calories, protein and author sent (one left out is kept; `null` clears it, and so does `''` for the author). Tags, favorite and link are kept | 200 `{recipe}` | 400 as above, 404 |
| `PUT /api/recipes/:id/tags` `{tags: [name]}` | Set its tags to exactly these names | 200 `{recipe, tags}` | 400 `invalid_request`, `name_required` (a blank name), `too_long` (a name > 100 chars, or > 20 tags), 404 |
| `PUT /api/recipes/:id/favorite` `{favorite: true\|false}` | Set (not toggle) the favorite | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `PUT /api/recipes/:id/public` `{public: true\|false}` | Set (not toggle) whether other users can see and copy it | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `DELETE /api/recipes/:id` | Move it, with its picture, to "Recently deleted" (below) | 200 `{ok}` | 404 |
| `GET /api/deleted-recipes` | The user's deleted recipes from the last 30 days, most recently deleted first | 200 `{recipes: [{id, en: {name}, he: {name}, deletedAt, expiresAt}]}` | |
| `POST /api/deleted-recipes/:id/restore` | Put it back among the user's recipes, with its tags | 200 `{recipe, tags}` | 404 (not theirs, already restored, or over 30 days old) |
| `GET /api/recipes/:id/picture[?size=thumb]` | The recipe's picture (or its thumb) as an image: yours, or anyone's public one (Browse) | 200 the bytes, `Cache-Control: private, max-age=31536000, immutable` | 404 (no picture, or another user's private recipe) |
| `PUT /api/recipes/:id/picture`, multipart `full` + `thumb` | Set the picture the user chose (`edited` 1), replacing any | 200 `{picture}` | 400 `picture_invalid`; 413 `picture_too_big`; 404 |
| `DELETE /api/recipes/:id/picture` | Remove its picture | 200 `{ok}` | 404 |

`recipe` is `{ id, tagIds, favorite, public, link, fromPhoto, sourceModel, calories, protein, author, picture, en, he }`, where `public` says
other users can see it in Browse (a new recipe gets the user's `defaultPublic`), `en` and `he` are
`{ name, ingredients: [string], steps: [string] }`, `link` is the source link (a video,
a post or a web page; `''` for manual recipes and for one read from a photo, whose
`fromPhoto` is then `true`; see [Import from a photo](IMPORT.md#import-from-a-photo)), `sourceModel` is the LLM that produced it (`null` for manual recipes) and
`tagIds` is the ids of its tags, lowest first (`[]` for none). `calories` (kcal) and
`protein` (grams) are per serving, whole numbers, `null` when not known; they are the same
in both languages, and `invalid_nutrition` means one isn't a whole number from 0 to 10000
(calories) or 1000 (protein). `author` is who the recipe is by (a chef, a channel, a site),
`''` when not known; it is the same in both languages, at most 100 characters
(`too_long`), and kept as the user typed it, with spaces tidied
(see [Author](IMPORT.md#author)). The backend trims names and
lines and drops blank lines. Limits (`too_long`): recipe name 200 chars, 200 ingredients
or steps per language, 2000 chars per line. The table also keeps
`machine_translated_lang` (which language an import's model filled in, as a translation),
and editing that language clears it; the API never returns it.

`picture` is `null`, or `{ url, thumb }`: `/api/recipes/<id>/picture?v=<updated_at>` and the
same with `&size=thumb`. The address changes with every new picture, so the browser caches
it for good. The picture upload is two parts the browser made from one picture (see
[Pictures](#pictures)), both JPEG or both WebP (checked by their first bytes, not only the
type they claim), `full` at most 1,000,000 bytes and `thumb` at most 100,000; anything else is
`picture_invalid` / `picture_too_big`. It is a `PUT`: another site's plain HTML form can
send multipart, but only by POST. The image answers carry `X-Content-Type-Options: nosniff`.

**Recently deleted.** Deleting a recipe moves it, in one batch, into `deleted_recipes`: a JSON
snapshot of the row (every column but its id) with its tag names, and its picture, as it
was, into `deleted_recipe_pictures`. Tags are kept by name
because a tag left on no recipe is still deleted at once, as before. For 30 days the owner
can restore it: the recipe comes back with its text, link, model, author, favorite, public flag,
calories, protein and picture, and each tag is found again by name (whatever its case now) or
created again. It gets a **new id**, so it shows first in "Newest first", and an old link to
`/recipe?id=<old>` no longer finds it. A Cloudflare **Cron Trigger** (`triggers.crons` in
`wrangler.jsonc`, daily at 03:00 UTC) runs `scheduled()` in `index.js`, which deletes
for good every row older than 30 days, with its picture; the list and restore already ignore those, so a
late run never shows one. A binned recipe doesn't count as saved, so the same link can be
imported again meanwhile; restoring it then gives two recipes. Locally, run the purge by
hand with `npx wrangler dev --test-scheduled --port <8788-8799>` and open
`/cdn-cgi/handler/scheduled` on that port (`/__scheduled` is served the static 404 page,
since only `/api/*` reaches the Worker first).

## Browse API

The only endpoints that read another user's recipes (`src/browse.js`). Both need a session.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/browse?seed=<n>[&after=<next>]` or `?sort=<order>[&after=<next>]` | One page (10) of other users' public recipes | 200 `{recipes, next}` | 400 `invalid_request` (an unknown `sort`, `seed` not a whole number from 1 to 1000002, or a bad `after`) |
| `POST /api/browse/:id/copy` `{}` | Save your own copy of that recipe | 201 `{recipe}` (the new one, as in the recipes API) | 404 `not_found` (missing, private, or your own) |

- A browsed recipe is `{ id, owner, tags, link, fromPhoto, author, picture, en, he }`: `owner` is the username of who
  saved it and `tags` its tag **names** (ids mean nothing to another user). The owner's
  favorite mark is never sent, nor the calories and protein (shown only on a recipe's own
  page); a copy brings them along.
- **What shows**: every public recipe of every other user. A copy keeps no link to its
  original (the owner's choice), so a recipe the user already saved shows again, another
  user's public copy shows beside the original, and saving one twice makes two copies.
- **Random order**: the browser picks `seed` once per visit. The order
  is by `(id + seed)³ mod 1000003`, so one seed always gives the same order and another
  seed a different one, with no stored state. `next` is where the page ended in that order
  (`null` on the last page) and comes back as `after`; continuing from the last recipe
  rather than from a count means a recipe deleted or made private meanwhile never makes a page
  skip or repeat one.
- **Sorted**: `sort` is `newest` or `oldest` (by id, which grows with time; a copy gets a
  new one), `protein` (most first), `kcal_high` or `kcal_low`; a recipe with no calories or
  protein comes after all that have them, and ties go oldest first. Every order, random
  included, is "a key, smallest first, then the id" (a "most first" key is the value turned
  negative), so they share the query and `next`. Leaving `sort` out (or `sort=random`)
  is the random order, and only it needs `seed`.
- **Copy**: the new recipe has the same text, link, platform, model and picture, no favorite, and
  is public or private by the user's `defaultPublic`. With
  `copyTags` on, each of the original's tags is found by name among the user's own tags or
  created. The original is never changed, and later changes to either don't reach the other.

## Import API

All need a session, work only on the data of the user the session acts for, and answer
404 for another user's import or recipe, like the API above. POST bodies must be JSON,
except a photo's, which is the picture itself.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/imports` `{url, model?}` | Start an import | 202 `{import}`, or 200 with the one already running | 400 `invalid_request`, `link_invalid`, `link_unsupported`; 409 `already_imported`; 429 `too_many_imports`, `quota` |
| `POST /api/imports/photo`, body: the picture, `Content-Type: image/jpeg\|png\|webp\|heic\|heif` | Start an import from one photo, best model first ([Import from a photo](IMPORT.md#import-from-a-photo)) | 202 `{import}` | 400 `photo_invalid`; 413 `photo_too_big`; 429 `too_many_imports`, `quota`; 502 `photo_upload_failed` |
| `GET /api/imports` | Cards plus model state | 200 `{imports, models}` | |
| `POST /api/imports/:id/retry` `{}` | Try a failed import again, as a new import | 202 `{import}` (the new one) | 400 `invalid_request`; 404; 409 `not_retryable`; 429 `too_many_imports`, `quota` |
| `DELETE /api/imports/:id` | Dismiss the card (and a photo's waiting picture) | 200 `{ok}` | 404 |
| `PUT /api/imports/:id/picture`, multipart `full` + `thumb` | A photo import's picture, made by the browser from the same photo ([Pictures](#pictures)) | 200 `{ok}` | 400 `picture_invalid`; 413 `picture_too_big`; 404 (not your photo import) |
| `POST /api/recipes/:id/rerun` `{model?}` | Scan an imported recipe's link again; replaces its text when done | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_rerunnable` (manual or photo recipe, or that link is running); 429 `too_many_imports`, `quota` |

- `import` is `{ id, status, stage, link, fromPhoto, title, error, retryable, recipeId, recipeName }`.
  `stage` is `meta`, `video`, `extract` or `save`. `link` is the stored link, which for a
  share link changes to the post's own link once the import has followed it; for a photo
  it is `''` and `fromPhoto` is `true` (`title` stays `null`).
  `recipeName` is `{ en, he }`, or `null` until there is a recipe. `error` is set only when
  `status` is `failed`.
- `GET` returns `running`, `failed` and `done` import rows, newest first, never `dismissed`
  or the AI tools' rows, and never reads `state`. It also marks `running` rows with no update for 30 minutes as failed
  with `timed_out`.
- `models` is `{ bestAvailable, bestLeftToday, bestLeftForUser, bestAvailableAt, resetsAt }`,
  times in epoch ms, about the best model only. `bestAvailable` is false when its shared
  count is used up or this user has used their 5; both are daily, so `bestAvailableAt` is
  then the reset, and `null` while it is available. For the admin `bestLeftForUser` is
  `null`: they have no 5, only the shared count. `resetsAt` is when every daily limit resets.
- `model` is normally left out: the backend picks the models ([Models](IMPORT.md#video-models-and-failures)). `'best'` asks
  for the best model first; the import still goes on by itself when that one can't be
  used. A Retry keeps the choice. A re-scan (`rerun`) takes the same `model` and follows
  every rule of a new import, except `already_imported`.
- POST checks in this order: body, link, a running duplicate, `already_imported`
  (`recipes.source_url`), caps, model state (only every import model being out stops it), then insert
  and start.
- Cap, counted from today's `quota_day`: `IMPORT_MAX_RUNNING` (3 running at once) counts
  import rows, so every Retry and re-scan too, but not the AI tools' requests. There is no
  daily count of imports: only the models' daily limits stop them. `IMPORT_BEST_DAILY_PER_USER` (5) counts every row with `used_best = 1`, and
  is the only per-user limit on a model.
- A Retry is a **new row**: it copies the failed row's link, title and model choice, starts
  over from the first stage in its own Workflow, and the failed row becomes `dismissed`
  (a photo's waiting picture moves to the new row).
  Only a failed save keeps its `state` and stage, since it already holds the recipe. It answers `not_retryable` if the same video is already running or saved
  (for a re-scan: if its recipe was deleted).

## Translate API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/translate` `{from, content, recipeId?}` | Translate one language's text into the other | 200 `{content}` | 400 `invalid_request`, `too_long`, `nothing_to_translate`; 404 (another user's recipe); 429 `quota` (no model can run); 502 `bad_result`, `llm_error`; 503 `model_busy` (every model it could use is busy) |

Needs a session like the rest. `from` is `'en'` or `'he'`, `content` is
`{ name, ingredients, steps }` (same checks and limits as a recipe), `recipeId` is the
recipe it belongs to (optional). There is no model choice. See [Translation](#translation).

## Nutrition API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/nutrition` `{content, recipeId?}` | Estimate calories and protein per serving | 200 `{calories, protein}` | 400 `invalid_request`, `too_long`, `no_ingredients`; 404 (another user's recipe); 429 `quota`; 502 `bad_result`, `llm_error`; 503 `model_busy` |

Needs a session. `content` and `recipeId` are as for translate (the language shown on
the recipe page). Stores nothing but its request row. See [Calories estimate](#calories-estimate).

## Substitute API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/substitute` `{recipeId, from, index, lang}` | Suggest substitutes for one ingredient | 200 `{substitutes: [{name, amount, note}]}` | 400 `invalid_request` (also an `index` past the list); 404 (not the user's recipe); 429 `quota`; 502 `bad_result`, `llm_error`; 503 `model_busy` |

Needs a session. The recipe is read from the database, so only the user's own saved recipe
works. `from` (`'en'` or `'he'`) is which language's ingredient list `index` (from 0) points
into, and `lang` the language to answer in. See [Ingredient substitutes](#ingredient-substitutes).

## Data

- **Users**: up to 50.
- **Every user has their own tags and recipes.** No other user changes them, and every
  query in `data.js` is filtered by the logged-in user. Other users can only read a recipe
  that is public (`recipes.is_public`, on by default), through the Browse API, and copy it.
- **Tags**: a flat list per user (`tags`), linked to recipes through `recipe_tags`, so a
  recipe has any number of them. A name is unique per user, ignoring the case of English
  letters. A tag exists only while a recipe has it: there is no create or delete
  endpoint. A tag can be renamed, but not to another tag's name (no silent merge).
- **Recipes**: name, source link, ingredients, and instructions, stored in **both English
  and Hebrew** so either version can be edited. Its tags are set on their own
  (see the API above), never with its text. A favorite is a flag on the recipe, since it is the owner's own mark and is never shown to others.
- **Deleted recipes** wait 30 days in `deleted_recipes` (see "Recently deleted" above), then
  the daily cron job deletes them for good. Deleting a user deletes theirs at once.
- **Model requests** live in the `llm_requests` table: **one row per request** a user
  makes, with a `purpose`: `import` (a new import, each Retry, each re-scan), `translation`, `nutrition` (a calories estimate) or `substitution` (ingredient substitutes); the last three are linked to their recipe by `recipe_id`. So an
  unfinished import never appears as a recipe, and the rows are the record of who used the
  models: `model` is the model whose answer the request ended with (also for a failed
  one, when a model did answer), and a user's daily best-model uses are their rows with
  `used_best = 1`. A row stays after it finishes, because the caps count it. `llm_usage` holds the app's own count of
  requests per Pacific day and model, shared by all users; it counts every request to
  Google, including a Workflow's own quick retries, which happen inside one row.

- **Pictures**: at most one per recipe, stored resized as BLOBs in `recipe_pictures` (a full
  picture and a thumb, about 165 KB a recipe at most), so deleting a user deletes them and
  copying is one statement. Deleting a recipe moves its picture to `deleted_recipe_pictures`
  with it, until it is restored or purged (see "Recently deleted"). A photo import's picture waits in `import_pictures`
  until its recipe is saved. See [Pictures](#pictures).

Every table, column and constraint is in [`schema.sql`](schema.sql), with comments on why.

## Database

Cloudflare D1 database `recipes-db`, bound to the Worker as `env.DB` in `wrangler.jsonc`.

- **Production**: `wrangler deploy` binds the real database.
- **Local dev**: `wrangler dev` uses a local SQLite copy in `.wrangler/state` and never
  touches production. `npm run dev` starts it on :8787 with whatever local data exists.
- **Refreshing the local copy (owner only)**: wrangler stays logged out so agents can't
  reach production. To copy production to local, run `npx wrangler login`,
  `npm run db:pull`, `npx wrangler logout`. `db:pull`
  ([`scripts/db-pull.mjs`](scripts/db-pull.mjs)) exports production (read-only), replaces
  the local database with that copy, then applies `schema.sql` locally. `wrangler d1
  execute` refuses statements over 100 KB, which a picture row is, so the picture rows are
  left out of the file it runs and inserted afterwards with their bytes bound
  ([`scripts/load-dump.mjs`](scripts/load-dump.mjs)). Pictures come along.
- **A worktree's local copy**: each git worktree has its own `.wrangler/state`, empty at
  first. `npm run db:copy-main` ([`scripts/db-copy-main.mjs`](scripts/db-copy-main.mjs))
  replaces it with a copy of the main checkout's local database (found through git), then
  applies `schema.sql`. It reads only local files and changes nothing in the main checkout.
- **Changing an existing table** needs a one-off file in [`migrations/`](migrations), run
  once by the owner on production (each file says how at its top). `schema.sql` can't do
  it: it only creates what is missing. Nothing records which migrations production has
  applied, and there is no rollback step (accepted): a file's name gives its date, and the
  PR that added it says when to run it. It may break the site for a few moments; the PR
  says when to run it relative to merging and what breaks (`AGENTS.md` → How to work here).
- **Schema**: [`schema.sql`](schema.sql) describes every table. It only uses
  `IF NOT EXISTS`, so applying it again is safe. The owner applies it to production by
  hand: `npx wrangler d1 execute recipes-db --remote --file=schema.sql`.
- **Leftovers on production**: an empty `folders` table and an always-NULL
  `recipes.folder_id` from before tags. Dropping them needs a rebuild of `recipes`, so they
  stay (accepted; `schema.sql` → recipes). New databases don't have them.
- The production dump (`.wrangler/prod-dump.sql`) holds real user data: it's git-ignored;
  never commit or paste it.
- PR previews (`wrangler preview`) use the same database, so a preview that someone uses
  reads and writes production. Previews don't inherit bindings, so the `previews` block in
  `wrangler.jsonc` repeats the D1 binding; without it every query fails. Accepted for now: nobody else gets the preview links, and
  a separate preview database may come later. It's a concern only if a PR would change
  production data during the build or deploy itself (see the `local-dev` skill).

## Pictures

A recipe has at most **one picture** (`src/pictures.js`, the only file that touches picture
bytes). It is stored **resized** in D1's `recipe_pictures`: `full` (at most 1280 px on its
longer side) for the recipe's page and `thumb` (240 px on its shorter side; the card crops
it to a square) for the Home and Browse cards, so no view ever resizes. Never an AI-made
picture of the dish.

| Where it comes from | `edited` | How |
|---|---|---|
| A link import | 0 | The Workflow's `picture` step |
| A photo import | 0 | A copy of the photo, resized in the browser |
| The edit form | 1 | Chosen by the user (gallery, camera or a file), resized in the browser |
| A copy from Browse | the original's | Copied with the recipe, in its batch |

- **A link's picture**: each adapter's `fetchPost` returns `pictureUrls`, best first:
  YouTube's `maxresdefault`, then `sddefault`, built from the video id (no API call);
  Facebook's and Instagram's `og:image` from the post page the import already fetched
  (signed links that expire in a few days, so the picture is copied, never linked); a web
  page's `og:image` (or `twitter:image`). A page Google opened for us (`url_context`) gives
  none: the Worker never read it. The save stage keeps the addresses on the row
  (`state.pictureUrls`), and the `picture` step, its own Workflow step after the save (one
  quick retry), fetches the first one that works, resizes it, saves it, and clears `state`.
  The fetch follows the web-page rules: `redirect: 'manual'`, `isFetchableUrl` at every hop,
  an image type only (JPEG, PNG, WebP, GIF, AVIF; never SVG), at most 10 MB, a 15-second
  timeout. Anything that goes wrong is logged and the recipe stays without a picture: **a
  picture never fails an import**.
- **Resizing a link's picture** is done by Cloudflare's **Images binding** (`env.IMAGES`,
  `wrangler.jsonc`, also under `previews`): the Worker can't decode an image in its CPU
  time. Free plan: 5,000 transformations a month, 2 per import; past that it fails (error
  9422, never a bill) and the recipe has no picture. `wrangler dev` and the tests run it
  offline on this computer (sharp), with the same results for what we use (`width`,
  `format`, `info`). Pictures the user picks never use it: the browser resizes them with a
  canvas (`frontend/lib/picture.js`).
- **A re-scan** replaces a picture only when `edited` is 0 (or fills a missing one); a
  picture the user chose stays (`savePictureStatement`, which also keeps a link's picture
  from overwriting one the user saved at the same moment). A photo import's photo has
  `edited` 0 too, but a photo recipe has no link, so it is never scanned again. A re-scan
  whose link has no picture keeps the old one. "Remove picture" deletes the row, so a later
  re-scan brings the link's picture back.
- **A photo import**: the original goes to Gemini (`POST /api/imports/photo`). Right
  after its 202, the browser sends `PUT /api/imports/:id/picture`. While the import
  runs (or failed, for a Retry) the picture waits in `import_pictures`; the save stage's
  batch moves it to the recipe, a Retry moves it to its new row, and dismissing deletes it.
  If the import already finished, it goes to the recipe at once (one batch either way).
- **Size**: about 165 KB a recipe at most (70 link pictures from real recipes averaged about
  120 KB + 22 KB). D1's free 500 MB is per database, shared with the recipes: about 3,000
  recipes with pictures. One BLOB, and one row, is at most 2 MB. If it ever gets close,
  `recipe_pictures` can move to a second D1 database in a one-off copy.
- **Old recipes**: a recipe imported before pictures existed has none until the user adds
  one or scans its link again (a re-scan fills a missing picture). Filling them in bulk is
  left to a separate script the owner runs.

**Known gaps and accepted trade-offs** (never fix one without asking the owner):

- A web page opened by Google (it blocked the Worker), or one with no `og:image`, gives
  its recipe no picture; the user can add one.
- A photo import's picture is made by the browser, so a HEIC photo the browser can't draw
  (most browsers but Safari) gives the recipe no picture (`frontend/README.md` → Screens →
  Add recipe).

## Users and login

- A user logs in with their **username and a password**.
- Passwords are never stored or logged in plain text: only a salted PBKDF2-SHA256 hash
  (WebCrypto, built into Workers), stored with its iterations and salt so the cost can
  be raised later.
- Anyone can sign up (`/api/auth/register`) while fewer than 50 users exist. Users change
  their own username and password (`PUT /api/auth/me`), without typing the old password:
  the owner chose that, since the session already proves who it is.
- Changing your own username or password keeps every login you already have (on all
  devices); the new details are needed only for the next login.
- After a successful login the user stays logged in on that device and doesn't see the
  login page again, unless they log out. Logins don't expire.
- **One session row per device**: the first login on a browser gives it a long-lived
  device id cookie (kept across logouts). Logging in again on that device replaces its
  row instead of adding one, so rows grow only with new devices. Logging out deletes it.
- Every API endpoint requires a logged-in user, except sign-up, login and logout.

## Import from a link or a photo

The import flow (the Workflow, each site, photos, models, quota and failures) is in
[`IMPORT.md`](IMPORT.md), with its known gaps.

## Translation

The recipe page's AI tools "Translate" sends the language shown to `POST /api/translate`,
which answers with the other language and stores nothing. The page then saves the recipe
at once with a normal `POST`/`PUT /api/recipes` (the frontend's job; this
endpoint never writes a recipe). It works for any recipe, manual ones too, but needs an account.

- One plain request, not a Workflow: the user waits for it, and a text-only call takes
  seconds. No video and no link are sent.
- Each translation is an `llm_requests` row with `purpose = 'translation'`, inserted before the
  call (status `running`, then `done` or `failed` with its `error`), with `recipe_id` set to
  its recipe (`NULL` when none is sent) and the answering model in `model`.
  The recipe text itself is never stored there. Translations never show as cards and don't
  count toward the import caps.
- There is no model choice and no per-user limit. A translation takes one request from
  the shared daily count (`llm_usage`) of the model that answers: the translation models
  in order (`LLM_TRANSLATE_MODELS`), then the fallback model.
- A busy, used-up or unusable model is skipped at once. When every model it could use
  was only busy (Google's "high demand" 503 usually passes in seconds), the whole list,
  fallback included, is tried again after each delay in `LLM_BUSY_RETRY_MS` (1.5 s, then
  3 s), so the user waits a few seconds instead of getting an error at once. Calories and
  substitutes do the same. Only every model staying busy (`model_busy`), out (`quota`), or
  unable to run (`llm_error`) fails.
- The answer is untrusted: it must pass the same checks as a recipe's text, have a name
  when the original had one, and have exactly as many ingredients and steps, so a dropped
  or merged line is never saved; otherwise it's `bad_result`.

## Calories estimate

The recipe page's "Calculate calories and protein" sends the language shown to
`POST /api/nutrition`, which answers `{ calories, protein }` per serving and stores
nothing; the page saves them with the recipe, like a translation. It works the same
way as [Translation](#translation) in every other respect: one plain request on the
translation models then the fallback, no model choice, no per-user limit, never a card.

- Each estimate is an `llm_requests` row with `purpose = 'nutrition'`, recorded like a
  translation's.
- The recipe needs at least one ingredient (`no_ingredients`).
- The model works step by step: it lists each ingredient with its grams, calories and
  protein (counting a main ingredient the steps use but the list leaves out), then the
  recipe's totals and its number of servings (the recipe's own, or a typical one). The
  backend divides the totals by the servings; a small model tested on real recipes came out
  much closer this way than asked for one number. Servings must be 1 to 200, and each
  number per serving is rounded and must be in the recipe's ranges (calories up to 10000,
  protein up to 1000), or it's `bad_result`.
- The servings are the weak spot: when a recipe doesn't say, the model guesses, and a wrong
  guess changes both numbers in proportion.

## Ingredient substitutes

The recipe page's "Substitute an ingredient" lets the user tap one ingredient and sends
`POST /api/substitute`, which answers up to 4 substitutes (`name`, `amount`, `note`), the
best first, written in the app's language. Nothing is stored but the request row: the page
shows the answer in a popup and forgets it when the popup closes. It works the same way as
[Translation](#translation) otherwise: one plain request, no model choice, no per-user
limit, never a card.

- **Model**: the translation models (`LLM_TRANSLATE_MODELS`, the small flash-lite model,
  500 requests a day), then the text-only fallback. A substitution is short text reasoning
  that the small model handles well, the user waits for it, and the stronger models' 20 a
  day are kept for videos and photos.
- The prompt holds the whole recipe (the language the ingredient is in), so the model
  knows what the ingredient does in the dish, and the chosen ingredient's text.
- Each request is an `llm_requests` row with `purpose = 'substitution'` (stage
  `substitution`) and `recipe_id`, recorded like a translation's.
- The answer is untrusted: it must hold a `substitutes` list (else `bad_result`); each
  field is trimmed and cut to 300 characters, entries with no name are dropped, and at most
  4 are kept. An empty list is a valid answer ("nothing would work").

## Secrets

`GEMINI_API_KEY`, `YOUTUBE_API_KEY` and the optional `GROQ_API_KEY` exist only in the
Worker (Worker secrets; `.dev.vars` locally, with placeholders in `.dev.vars.example`).
Never send them to the frontend or commit them. Without a key, `llm.js` and
`sources/youtube.js` fail at once and send nothing, and without `GROQ_API_KEY` the fallback
model is simply never used. Facebook and Instagram need no key.

## Deploy

Cloudflare Workers Builds is connected to the GitHub repo and deploys on every merge to
`main`, including the frontend build. Database schema changes are applied to production
by the owner (see [Database](#database)).
