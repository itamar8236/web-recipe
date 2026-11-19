# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
YouTube, Facebook and Instagram links, recipe web pages and photos of written recipes into recipes, and serves the frontend's static build. Read the root
`AGENTS.md` first.

Record new files, schema and endpoints here in the same PR that adds them.

## Current state

The Worker (`src/index.js`) runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`);
everything else is the static build from `../frontend/out`, served by Cloudflare. Run it
locally with `npm run dev` (port 8787, after `npm run build` in `frontend/`). Never run
`npm run deploy` (`wrangler deploy`): production is deployed only by merging a PR into
`main`, through Workers Builds (root directory `/`), which builds with
`cd frontend && npm install && npm run build` and then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production).
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a
  Worker Preview that doesn't replace the production Worker, but shares its database
  (see [Database](#database)). It needs the `previews` block in
  `wrangler.jsonc`.

Code: `src/index.js` (routes and auth), `src/data.js` (tags and recipes), `src/browse.js`
(other users' public recipes),
`src/imports.js` (import endpoints), `src/translate.js` (translation), `src/nutrition.js` (calories estimate), `src/substitute.js` (ingredient substitutes), `src/http.js` (JSON helpers), `src/session.js`
(cookies and the `sessions` table), `src/password.js` (PBKDF2), and `src/import/`:
`workflow.js` (the background job), `stages.js` (what each stage does), `models.js` (model
choice, usage counting, reset time), `llm.js` (the only file that knows
Gemini's format, including its file store for videos and photos), `groq.js` (the only file that knows
Groq's format, for the fallback model), `errors.js`, and `sources/` (link detection and one
adapter per site: `youtube.js`, `facebook.js`, `instagram.js`, with `meta.js` for what the
last two share, `web.js` for any other web page, and `photo.js` for an uploaded photo, which
is never matched against a link). `scripts/e2e-links.mjs` runs real imports through the local app by hand. Tests: `npm test` (`test/`, Vitest in the Workers runtime on a
throwaway local D1 built from `schema.sql`; never touches production or `.wrangler/state`).

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
device. Not built yet: login rate limiting.

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
| `POST /api/recipes` `{en, he, calories?, protein?}` | Create a manual recipe, with no tags | 201 `{recipe}` | 400 `name_required` (no name in either language), `too_long`, `invalid_nutrition` |
| `PUT /api/recipes/:id` `{en, he, calories?, protein?}` | Replace its text, and the calories and protein sent (one left out is kept; `null` clears it). Tags, favorite and link are kept | 200 `{recipe}` | 400 as above, 404 |
| `PUT /api/recipes/:id/tags` `{tags: [name]}` | Set its tags to exactly these names | 200 `{recipe, tags}` | 400 `invalid_request`, `name_required` (a blank name), `too_long` (a name > 100 chars, or > 20 tags), 404 |
| `PUT /api/recipes/:id/favorite` `{favorite: true\|false}` | Set (not toggle) the favorite | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `PUT /api/recipes/:id/public` `{public: true\|false}` | Set (not toggle) whether other users can see and copy it | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `DELETE /api/recipes/:id` | Delete | 200 `{ok}` | 404 |

`recipe` is `{ id, tagIds, favorite, public, link, fromPhoto, sourceModel, calories, protein, en, he }`, where `public` says
other users can see it in Browse (a new recipe gets the user's `defaultPublic`), `en` and `he` are
`{ name, ingredients: [string], steps: [string] }`, `link` is the source video (`''` for
manual recipes and for one read from a photo, whose `fromPhoto` is then `true`; see
[Import from a photo](#import-from-a-photo)), `sourceModel` is the LLM that produced it (`null` for manual recipes) and
`tagIds` is the ids of its tags, lowest first (`[]` for none). `calories` (kcal) and
`protein` (grams) are per serving, whole numbers, `null` when not known; they are the same
in both languages, and `invalid_nutrition` means one isn't a whole number from 0 to 10000
(calories) or 1000 (protein). The backend trims names and
lines and drops blank lines. Limits (`too_long`): recipe name 200 chars, 200 ingredients
or steps per language, 2000 chars per line. The table also keeps
`machine_translated_lang` (which language an import's model filled in, as a translation),
and editing that language clears it; the API never returns it.

## Browse API

The only endpoints that read another user's recipes (`src/browse.js`). Both need a session.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/browse?seed=<n>[&after=<next>]` or `?sort=<order>[&after=<next>]` | One page (10) of other users' public recipes | 200 `{recipes, next}` | 400 `invalid_request` (an unknown `sort`, `seed` not a whole number from 1 to 1000002, or a bad `after`) |
| `POST /api/browse/:id/copy` `{}` | Save your own copy of that recipe | 201 `{recipe}` (the new one, as in the recipes API) | 404 `not_found` (missing, private, or your own) |

- A browsed recipe is `{ id, owner, tags, link, fromPhoto, en, he }`: `owner` is the username of who
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
- **Copy**: the new recipe has the same text, link, platform and model, no favorite, and
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
| `POST /api/imports/photo`, body: the picture, `Content-Type: image/jpeg\|png\|webp\|heic\|heif` | Start an import from one photo, best model first ([Import from a photo](#import-from-a-photo)) | 202 `{import}` | 400 `photo_invalid`; 413 `photo_too_big`; 429 `too_many_imports`, `quota`; 502 `photo_upload_failed` |
| `GET /api/imports` | Cards plus model state | 200 `{imports, models}` | |
| `POST /api/imports/:id/retry` `{}` | Try a failed import again, as a new import | 202 `{import}` (the new one) | 400 `invalid_request`; 404; 409 `not_retryable`; 429 `too_many_imports`, `quota` |
| `DELETE /api/imports/:id` | Dismiss the card | 200 `{ok}` | 404 |
| `POST /api/recipes/:id/rerun` `{model?}` | Scan an imported recipe's video again; replaces its text when done | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_rerunnable` (manual recipe, or that video is running); 429 `too_many_imports`, `quota` |

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
- `model` is normally left out: the backend picks the models (see Models). `'best'` asks
  for the best model first; the import still goes on by itself when that one can't be
  used. A Retry keeps the choice. A re-scan (`rerun`) takes the same `model` and follows
  every rule of a new import, except `already_imported`. `'basic'` and `useBasicModel`,
  which an older page may send, mean the normal case.
- POST checks in this order: body, link, a running duplicate, `already_imported`
  (`recipes.source_url`), caps, model state (only every import model being out stops it), then insert
  and start.
- Caps, counted from today's `quota_day`: `IMPORT_MAX_RUNNING` (3 running) and
  `IMPORT_DAILY_LIMIT` (10 a day) count import rows, so every Retry and re-scan too, but not
  the AI tools' requests. `IMPORT_BEST_DAILY_PER_USER` (5) counts every row with `used_best = 1`, and
  is the only per-user limit on a model.
- A Retry is a **new row**: it copies the failed row's link, title and model choice, starts
  over from the first stage in its own Workflow, and the failed row becomes `dismissed`.
  Only a failed save keeps its `state` and stage, since it already holds the recipe. It answers `not_retryable` if the same video is already running or saved
  (for a re-scan: if its recipe was deleted). A failed `model_approval_needed` row (from
  before approvals were dropped) can be retried and just runs.

## Translate API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/translate` `{from, content, recipeId?}` | Translate one language's text into the other | 200 `{content}` | 400 `invalid_request`, `too_long`, `nothing_to_translate`; 404 (another user's recipe); 429 `quota` (no model can run); 502 `bad_result`, `llm_error`; 503 `model_busy` (every model it could use is busy) |

Needs a session like the rest. `from` is `'en'` or `'he'`, `content` is
`{ name, ingredients, steps }` (same checks and limits as a recipe), `recipeId` is the
recipe it belongs to (omit for one not saved yet; the app now always sends it). There is no model choice; a `model`
field from an older page is ignored. See [Translation](#translation).

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
- **Model requests** live in the `llm_requests` table: **one row per request** a user
  makes, with a `purpose`: `import` (a new import, each Retry, each re-scan), `translation`, `nutrition` (a calories estimate) or `substitution` (ingredient substitutes); the last three are linked to their recipe by `recipe_id`. So an
  unfinished import never appears as a recipe, and the rows are the record of who used the
  models: `model` is the model whose answer the request ended with (also for a failed
  one, when a model did answer), and a user's daily best-model uses are their rows with
  `used_best = 1`. A row stays after it finishes, because the caps count it. `llm_usage` holds the app's own count of
  requests per Pacific day and model, shared by all users; it counts every request to
  Google, including a Workflow's own quick retries, which happen inside one row.

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
  the local database with that copy, then applies `schema.sql` locally.
- **A worktree's local copy**: each git worktree has its own `.wrangler/state`, empty at
  first. `npm run db:copy-main` ([`scripts/db-copy-main.mjs`](scripts/db-copy-main.mjs))
  replaces it with a copy of the main checkout's local database (found through git), then
  applies `schema.sql`. It reads only local files and changes nothing in the main checkout.
- **Changing an existing table** needs a one-off file in [`migrations/`](migrations), run
  once by the owner on production (each file says how at its top). `schema.sql` can't do
  it: it only creates what is missing. It may break the site for a few moments; the PR
  says when to run it relative to merging and what breaks (`AGENTS.md` → How to work here).
- **Schema**: [`schema.sql`](schema.sql) describes every table. It only uses
  `IF NOT EXISTS`, so applying it again is safe. The owner applies it to production by
  hand: `npx wrangler d1 execute recipes-db --remote --file=schema.sql`.
- The production dump (`.wrangler/prod-dump.sql`) holds real user data: it's git-ignored;
  never commit or paste it.
- PR previews (`wrangler preview`) use the same database, so a preview that someone uses
  reads and writes production. Previews don't inherit bindings, so the `previews` block in
  `wrangler.jsonc` repeats the D1 binding; without it every query fails. Accepted for now: nobody else gets the preview links, and
  a separate preview database may come later. It's a concern only if a PR would change
  production data during the build or deploy itself (see the `local-dev` skill).

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

## Import from a link

Users paste a link and go back to the video, and a normal request stops when they leave, so
imports run in a **Cloudflare Workflow**. The recipe is written once, complete, with no
tags and no review: the user can edit or delete it afterwards.

```
POST /api/imports {url}
  parse link → guards → choose model → insert llm_requests row → start Workflow → 202

Workflow: each stage is one retried step, and saves its result to the row
  meta     The post's details from its site: title, text, subtitles, video facts (no LLM);
           for a web page, its title and text
  video    Facebook and Instagram only: stream the video file into Gemini's file store
  extract  One call with the text and, if it can be sent, the video; the same call
           gives the calories and protein per serving
  save     One D1 batch: insert the recipe, or replace it on a re-scan, + mark the import done
```

**Calories and protein.** The extract prompt asks for them per serving, as whole numbers:
the post's own numbers if it gives them, otherwise the model's estimate from the
ingredients and the number of servings. They are optional in the answer schema, so a model
that leaves them out still gives the recipe. A value that is missing, or outside 0-10000
kcal / 0-1000 g, is stored as `null` rather than failing the import; decimals are rounded.
A re-scan replaces them along with the text. Manual recipes don't call the model for them
(a later feature).

**Links.** Only the backend decides which site a link is (`sources/index.js`), from the
link's text alone. A new platform is one adapter added to `SOURCES` (the adapter shape is
described at the top of that file); `stages.js` knows no site. Any other link is a web page
(`web.js`, the last adapter), unless `isFetchableUrl` refuses it (`link_unsupported`: an IP
address, a private-network or single-label name, another port, or a login in the link). A
link on a known site that isn't a post answers `link_invalid`, never a web page. The stored
link is rebuilt from the parsed id (for a web page: the link without its `#fragment` and
tracking parameters such as `utm_*` and `fbclid`), so every form of one post is the same import.

- YouTube: `watch?v=`, `youtu.be/`, `shorts/`, `live/`.
- Facebook (`facebook.com`, `www.`, `m.`, `web.`, `fb.watch`): `/reel/<id>`,
  `/watch?v=<id>`, `/video.php?v=<id>`, `/<page>/videos/[<title>/]<id>`, stored as
  `https://www.facebook.com/watch/?v=<id>`. Share links: `/share/<code>`,
  `/share/v|r|p/<code>`, `fb.watch/<code>`.
- Instagram (`instagram.com`, `www.`, `instagr.am`): `[/<user>]/reel|reels|p|tv/<code>`,
  stored as `https://www.instagram.com/p/<code>/`. Share links: `/share/[reel|p/]<code>`.

**The Worker fetches a pasted URL as it is only for a web page** (see Web pages). For the
three sites it fetches only URLs it builds from the parsed id, with `redirect: 'manual'`, and follows each redirect by hand only onto the
site's own hosts (`fetchPage` in `sources/meta.js`). Video and subtitle files are fetched
only from Meta's CDN (`*.fbcdn.net`, `*.cdninstagram.com`), and the upload address Gemini
answers with is used only on Google's own host.

**Share links.** A share link doesn't say which post it is, so it starts as its own id
(`share/r/<code>`). The `meta` stage follows it, writes the post's real id and link on the
row, and then does the duplicate checks a normal link gets before starting: if the user
already has that recipe the card fails with `already_imported`, and if the same post is
already being imported (the unique index) the newer row dismisses itself. A share link that
leads to something that isn't a video or post fails with `link_unsupported`.

### Web pages

Any public page with a recipe, such as a recipe site or a blog post (`sources/web.js`).
There is no id to rebuild a link from, so the pasted link is fetched, and that is guarded:

- `isFetchableUrl` checks the link and **every redirect hop**, followed by hand (at most 5,
  onto any public host, since a site often moves to its `www.` host): http or https, the
  default port, no `user:pass@`, and a real domain name, never an IP address (the URL parser
  turns every numeric form into one), `localhost` or a private-network name (`.local`,
  `.internal`, ...). Cloudflare's own fetch can't reach private addresses either.
- One request with a browser's headers, a 30-second timeout, at most 5 MB, and only
  `text/html`, `application/xhtml+xml` or `text/plain`; anything else is
  `link_unsupported`. Nothing the page links to is fetched, and no video is sent.
- The text sent to the model is what a reader sees: scripts, styles, menus, footers,
  sidebars and buttons are dropped, one block per line, at most 20,000 characters. A
  schema.org `Recipe` block (JSON-LD, which many recipe sites have for search engines) goes
  first when it has ingredients and steps, followed by the page text, since such blocks
  often leave a part out (a topping's ingredients). The card's title is `og:title` or
  `<title>`.
- The prompt tells the model that a page's menus, ads, comments and other recipes' titles
  are not part of the recipe. A page with no recipe ends as `no_recipe`, one with several
  as `multiple_recipes`, and one with under 80 characters of text as `no_recipe` with no
  model call.
- Failures: 404 or 410 is `video_unavailable`; 401, or a redirect to a login path, is
  `login_required`; 403, 429, 5xx and a site that can't be reached (also a domain that
  doesn't exist) are `source_blocked`, retried by the Workflow; any other 4xx is
  `source_blocked` with no retry.
- A site that builds its page only in JavaScript, or blocks requests from servers, can't be
  read (`no_recipe` or `source_blocked`). "Scan the link again" reads the page again.
- Tested on 2026-11-17 on four Hebrew recipe sites (kerenagam.co.il, israelhayom.co.il,
  mako.co.il, boxfromjerus.co.il): all four gave the full recipe on `gemini-3.6-flash`.

### Facebook and Instagram

Both are read the way an anonymous visitor's browser reads a
public post: one page request with the headers a browser sends (Facebook answers 400
without them), no account, cookies, tokens, proxies or scraping services. The post's data
is in `<script type="application/json">` blocks; only the one or two blocks that mention
the post are parsed, and the facts are found by their field names and the post's id, not
by a fixed path, because the layout differs between a reel page and a watch page.

- Facebook gives the caption, the length, a video file and sometimes an auto-made subtitle
  track (`.srt`, fetched as extra text). Only videos and reels: a photo or text post is
  not supported.
- Instagram gives the caption, a video file and its length (from the streaming manifest).
  A photo or carousel post has no video and is read from its caption.
- A page that came without its data blocks still gives the link-preview text
  (`og:title`/`og:description`) as a caption-only import.
- This was built and tested from a home connection. Cloudflare's network may be answered
  differently (a login wall or a block), which shows as `login_required` or
  `source_blocked` with the reason in `error_detail` and in the logs. Meta can also change
  its pages at any time; `scripts/e2e-links.mjs` is the check.

### Import from a photo

A logged-in user sends **one picture** of a written recipe (a cookbook page, a screenshot,
a handwritten card). It goes through the same Workflow as a link and is saved the same way,
with no tags.

```
POST /api/imports/photo   body = the picture, Content-Type image/jpeg|png|webp|heic|heif
  guards: session, type (photo_invalid), size 1 byte - 20 MB (photo_invalid, photo_too_big),
          caps, model state (with the best model chosen)
  upload the body, streamed, to Gemini's file store → { name, uri, mimeType }
  insert llm_requests row: platform 'photo', source_id <random 32-hex id>,
    source_url 'photo:<id>', state { photo: file, bestChosen: true }   → start Workflow → 202
Workflow: meta has nothing to fetch, video is skipped, extract waits for the file and makes
  one call (photo prompt + image at resolution 'high'), save as for a link, then deletes the file
```

- **The picture is never kept.** It is only ever in Gemini's file store (the same store as
  Facebook and Instagram videos, not our database), and is deleted when the import ends:
  after the save, when the model found no recipe, when Google refused it, and when the card
  is dismissed. A failed import that may be retried keeps it until Google deletes it
  (48 hours). Only its file name, type and size are logged, never its uri.
- **The best model first, always.** Every photo import is like `model: 'best'`: it takes
  one of the user's 5 when it calls the best model, and when the best model can't be used
  (shared count or the user's 5 used, busy, or can't run) it goes on with the import models
  by itself. A photo never reaches the text-only fallback model.
- **Only written recipes.** The prompt says a picture of food with no written recipe is
  `none` (`no_recipe`): the model never guesses a recipe from how a dish looks.
- **The same picture twice** is allowed: each upload gets its own random id and makes its
  own recipe, for when the first read wasn't good enough. No hash, no `already_imported`.
- **Size rule.** The backend takes up to 20 MB; the frontend sends every picture up to 15 MB
  unchanged and shrinks only a bigger one (`frontend/lib/photo.js`). Gemini scales every
  image down itself (about 1,100 image tokens at `high` for each test picture), so a phone
  photo or screenshot is sent as it is, to keep small print readable.
- **The API**: a photo recipe's `source_url` is `photo:<id>` (no schema change: `platform`
  is free text, and the `photo:` value satisfies both CHECKs). Recipes, Browse and the
  import cards answer `link: ''` and `fromPhoto: true` for it, and a copy from Browse keeps
  both. `readLink` never accepts `photo:` text, so a photo recipe can't be scanned again
  (`not_rerunnable`).
- **Retry** keeps `state.photo` and the best model (the picture itself is no longer here).
  After Google's 48 hours the file is gone and it fails with `photo_expired`.
- **Google's copyright block.** Google refuses (400, `recitation`) to write out text it
  recognises as published and copyrighted. In testing (2026-11-18) a photo of a famous
  chef's recipe page was refused by both the best model and `gemini-3.8-flash`, so a photo
  import fails at once with `photo_copyrighted` rather than trying the other models.
- **Later**: the random id is meant to be the R2 object key (`photos/<id>`) if a later
  feature keeps the picture; `createPhotoImport` in `imports.js` is the one place that
  handles the uploaded bytes, and the Workflow only knows "a file Gemini can read".

**Quality test (2026-11-18).** The owner's three test pictures, sent as they are (none is
over 2048 px on its longest side, so resizing to 4096, 3072 or 2048 px would change nothing):

| Picture | Size | Upload | Best model (`gemini-4-hydrogen`) | `gemini-3.8-flash` |
|---|---|---|---|---|
| Hebrew recipe card over a dish photo, 720×1280 | 189 KB | ~3 s | complete and correct, 38 s, 1,100 image tokens | complete and correct, 18 s (one try took 388 s on Google's side) |
| Hebrew Instagram story screenshot, 945×2048 | 241 KB | ~2.5 s | complete and correct, 88 s, 1,078 image tokens | complete and correct, 18 s; added an oil line not in the picture |
| Photo of a recipe web page on a monitor, at an angle, 1920×1080 | 378 KB | ~3 s | refused: `recitation` | refused: `recitation` |

### Video, models and failures

**Video.** A video is sent if it's public and at most `IMPORT_MAX_VIDEO_MINUTES` (3); one
of unknown length is not sent. Gemini reads a YouTube video from its link. A Facebook or
Instagram video is a file, so the `video` stage streams it from the CDN into Gemini's file
store (free, deleted by Google after 48 hours) without holding it in memory, refusing a file
over `IMPORT_MAX_VIDEO_MB` (100). `extract` waits until the file is processed and sends its
uri. The file is deleted when the import ends: by `save` once the recipe is written, or by
`extract` when the model found no recipe (a bad answer is asked for again and still needs
it). If the download or upload is refused for good and there is enough text, the import
goes on with the text and remembers why (`state.videoSkipped`); with no text it fails. A
failure that may pass (a server error, the network) is retried by the Workflow first.

**Extract.** The description counts if it's at least 80 characters, and so do subtitles.
If neither text nor video can be sent, it fails with no LLM call. One call with whatever
can be sent returns the recipe in both languages, with the post's own language written
first. Everything from the site is sent as data, and everything the model returns is
untrusted and is validated before it's stored.

**Models.** Users choose nothing by default; `models.js` tries models in a fixed order and
moves on **at once** from one that is busy (503), hit a short rate limit, is out for the
day, or can't run (below). All of it is config (`wrangler.jsonc`), so changing a model, the order or a limit
needs no code change:

| Setting | Value | Used for |
|---|---|---|
| `LLM_IMPORT_MODELS` | `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` | Imports, Retries and re-scans, in this order |
| `LLM_TRANSLATE_MODELS` | `gemini-3.5-flash-lite` | The AI tools (translate, calories, substitute): text work for the small model, which leaves the stronger models' few requests for videos |
| `LLM_FALLBACK_MODEL` | `openai/gpt-oss-120b` (Groq) | After either list, for a request with **no video** |
| `LLM_BEST_MODEL` | `gemini-4-hydrogen` | When the user asks for it, and first for every photo |
| `LLM_DAILY_LIMITS` | 20, 20, 500, 20 and 200 a day | Every model's requests a day. A model missing from it is never called |
| `LLM_BUSY_RETRY_MS` | `1500,3000` | The AI tools only: when every model they could use is busy, wait this long and try them all again, once per number |

- **The best model** is the one choice a user has ("Use the best model" in the recipe
  page's "Scan the link again" confirmation; `model: 'best'` in the API), and every photo import uses it by default, with no
  checkbox. It is slower and more detailed. It is tried first,
  once; if it is busy, out for the day, or the user has used their 5, the import goes on
  with the import models by itself, and nobody is told or asked. Photos share its 20 a day
  with re-scans, so on a busy day most photo imports use the import models.
- **The fallback model** can't watch a video or read a photo, so a request with one never reaches it. It
  is off until `GROQ_API_KEY` is set. Groq's free limit when checked was 1,000 requests and
  200,000 tokens a day, 8,000 tokens a minute.
- **A model that can't run** (`ModelUnusableError`): Google or Groq rejected the request
  with a 4xx other than 429 that is about the model or the key, such as a retired or renamed
  model (404) or a key that isn't accepted (400/401/403). The failure is logged, its
  request is given back to the shared count, and the next model is tried; a best model
  that can't run still uses up one of the user's 5, like any try that reached Google. A
  request with no video is only our prompt, so any such 4xx counts. With a video, a 4xx
  counts only when Google's message names the model, the key, or the API being off
  (`SERVICE_DISABLED`), or it is a 401; any other is the video being refused
  (`VideoRefusedError`), and the stage asks again without it (see Failures).
- **Which model answered** is stored on the recipe (`source_model`) and on the request
  (`llm_requests.model`).
- When tested on the same six links (2026-11-14), `gemini-3.6-flash` and
  `gemini-4-hydrogen` both gave full recipes; hydrogen's were the most detailed and three
  to four times slower, and `gemini-3.8-flash` was busy most of the time. The limits (20 a
  day each) are what AI Studio showed the owner.

**The user's 5.** Only the best model has a per-user limit (`IMPORT_BEST_DAILY_PER_USER`).
A row takes one of the 5 (`used_best = 1`, in one statement, so two rows can't take the
last one) when it is about to call the best model, and keeps it once a request reached
Google, even if the model was busy or answered with a quota error and another model wrote
the recipe: trying the best model is what the 5 count. A row calls the model more than once
(Workflow retries, busy waits, a second ask without the video) but takes the use only once.
It is given back only when nothing was sent (the shared count was already used up). The
choice (`state.bestChosen`) holds through Workflow retries, busy waits and a Retry.
The admin (`users.is_admin = 1`, not while they act as another user) has no 5: their rows
are still marked `used_best`, but only the shared count stops them using the best model.

**Quota.** Daily quotas reset at **midnight Pacific** (`nextQuotaReset`). Google offers no
way to ask how many requests are left, so `llm_usage` counts them: every real call first
reserves one, in one atomic statement, up to the model's limit in `LLM_DAILY_LIMITS`. A
failed call still counts, because Google may have counted it, except a 503, a short rate
limit, or a model that can't run: Google says a 503 is "unrelated to your quota", and a
rejected request is never served, so its request is given back to this shared count (not to the user's 5, see above). Some users report Google counts them anyway;
if so, Google's per-day 429 below sets the count right. A 429 naming a per-day quota sets
the model's count to the limit, which alone keeps it unused until the reset. Any other 429
(a per-minute limit) is treated like a busy model; nothing is remembered, so the next
request simply tries. In every case the request moves to the next model at once.

**Failures.** `error` is written to the row before a stage throws, with the reason in words
in `error_detail` (never sent to the browser).

| Case | Code | Automatic retry | User can Retry |
|---|---|---|---|
| Removed or private, or the video couldn't be used and nothing else had the recipe; a web page that answered 404/410 | `video_unavailable` | no | no |
| The site redirected to a login page, or shows the post only after a login | `login_required` | no | yes |
| The site answered 403/429/5xx, or sent a page with none of the known parts | `source_blocked` | yes, 3 tries | yes |
| A share link led to a recipe the user already has | `already_imported` | no | no |
| A share link led to something that isn't a video or post; a web page redirected to a refused address, or isn't a page (a PDF, an image, over 5 MB) | `link_unsupported` | no | no |
| Private or unlisted, description not enough | `video_private` | no | no |
| Too long, description not enough | `video_too_long` | no | no |
| No recipe | `no_recipe` | no | no |
| Several recipes | `multiple_recipes` | no | no |
| Every model it could use is busy (503) | `llm_error` | yes, see below | yes |
| Other 5xx, network, timeout | `llm_error` | yes, 3 tries per stage | yes |
| Invalid output | `bad_result` | yes, 3 tries per stage | yes |
| Every model it could use is out for the day (some may also have been unable to run) | `quota` | no | yes |
| No model it could use can run (all retired or key refused) | `llm_error` | no | yes |
| Stuck for 30 minutes | `timed_out` | no | yes |
| Photo: Google refused the picture, or couldn't process it | `photo_unreadable` | no | no |
| Photo: Google won't write out a published recipe (`recitation`) | `photo_copyrighted` | no | no |
| Photo: the uploaded file is gone (a Retry after Google's 48 hours) | `photo_expired` | no | no |

A photo is refused before any row exists, so these answer the POST and never show as cards:
`photo_invalid` (not one of the five image types, or empty), `photo_too_big` (over 20 MB),
`photo_upload_failed` (Google's file store wouldn't take it).

Each stage may take 15 minutes; a Gemini request is cancelled after 14, so a retry never
overlaps a call that is still running (video calls have taken over 5 minutes).

A busy model (503, "high demand") costs nothing: the stage moves on to the next model in
the same run. Only when **every** model it could use was busy does the stage end as busy.
That can last minutes or hours, so it skips the quick retries and follows Google's advice
instead: back off and retry, short at first and longer after. The stage ends without
failing, and the Workflow sleeps (`step.sleep`) **30 seconds, then 2 minutes, then 8
minutes** before each new run, so 4 runs in all, each starting again from the first model
(and from the best model, when the user asked for it); still busy after that, it fails with
`llm_error`. The card shows the import as still running meanwhile. Every busy answer's
request is given back to the shared count.

No wait has jitter: there are too few users for their retries to pile up, and a Workflow
must sleep the same on every replay. Google's Batch API is not used: its results can take
hours, and imports should land in minutes.

A Retry inserts a new row and starts a new Workflow from the first stage, keeping only the
model choice (`state.bestChosen`). It doesn't reuse what the earlier stages left, because
that expires: Meta's video links are signed for a limited time and Google deletes an
uploaded video after 48 hours, and getting them again costs no model request. The one
exception is a failed save, whose `state` holds the recipe the model already wrote: it is
copied, so no model is called again. Within one Workflow, finished stages are skipped
through `state.done`, so a repeated step doesn't depend on how long Workflows keeps its
history. `state.version` says which shape the state has; a row holding
an older shape starts again from its first stage, keeping only its model choice. Every write is guarded by `status = 'running'` and the
attempt, so a repeated step or a dismissal writes nothing, and a recipe is never saved
twice. (New rows always have `attempt` 1; older rows retried in place may have more.)

**Provider.** Everything about Gemini's request format is in `llm.js` and everything about
Groq's in `groq.js`; `models.js` alone decides which model runs and counts the calls.

**Limits to keep in mind.** Quota is per Google project and shared by all users: 20
requests a day on each of the three stronger models and 500 on the small one, and Google
says the limits aren't guaranteed. PR previews
can't exercise any of this: a preview's binding uses the Workflow already deployed to
production, and gives `workflow.not_found` before the first deploy. A photo import fails on
a preview at once with `photo_upload_failed`: the upload runs in the preview Worker itself,
and previews don't inherit Worker secrets, so it has no `GEMINI_API_KEY` (the log says
"Photo upload failed: GEMINI_API_KEY is not set"). Giving previews the key wouldn't be
enough before a merge either, since production's Workflow code doesn't know photos yet, and
would let any preview spend the production quota. Test photo imports locally.

**Logging.** `llm.js` logs each Gemini request (the model, the video link, or only the
type of a user's photo, and the full prompt), each answer (how long it took and the tokens
Google counted, the image's among them), each upload (file name, type, size and time) and
each failure (the status and Google's error text), never the key. Every prompt is logged
in full, the AI tools' too, which hold the user's own recipe (the owner's choice, for
debugging); `groq.js` logs the fallback model's the same way. Production keeps the logs for 3
days (Workers Logs, `observability` in `wrangler.jsonc`), and `npx wrangler tail` shows
them live. A failed import also keeps the reason in `llm_requests.error_detail`.

**Testing.** Tests use fake keys and stubs, and `vitest.config.mjs` refuses every outbound
request. Real imports run locally on the dev keys in `.dev.vars`, which use a test quota;
agents don't ask for the best model unless the owner says so (`local-dev` skill).

### Known small gaps

All rare and harmless:

- "Scan the link again" still shows while that scan is running; tapping it answers
  `not_rerunnable`.
- A Retry that can no longer work says so and leaves the card for the user to dismiss.
- Home can miss one recipe-list reload if an import finishes in the instant between its first
  two requests. Opening the ready card still works.
- A running import dismissed through the raw API (the UI has no × on running cards) may still
  finish its LLM call, but saves nothing.
- An uploaded video stays in Gemini's file store until Google deletes it (48 hours) when
  its import fails before a usable answer. A Retry uploads the video again.
- A photo import that failed in a way Retry can help with keeps its picture in Gemini's file
  store until the card is dismissed or Google deletes it (48 hours); after that a Retry
  fails with `photo_expired`, and the user chooses the photo again.
- A photo import's "Pick a link with one recipe" (`multiple_recipes`) still says "link".
- When every import model is out for the day a new import is refused with `quota` before
  it starts, even if the fallback model could have read its text.
- A scan that asked for the best model doesn't say when another model answered instead;
  the recipe's `source_model` shows it.

## Translation

The recipe page's AI tools "Translate" sends the language shown to `POST /api/translate`,
which answers with the other language and stores nothing. The page then saves the recipe
at once with a normal `POST`/`PUT /api/recipes` (the frontend's job; this
endpoint never writes a recipe). It works for any recipe, manual ones too, but needs an account.

- One plain request, not a Workflow: the user waits for it, and a text-only call takes
  seconds. No video and no link are sent.
- Each translation is an `llm_requests` row with `purpose = 'translation'`, inserted before the
  call (status `running`, then `done` or `failed` with its `error`), with `recipe_id` set to
  its recipe (`NULL` for one not saved yet, from an older page) and the answering model in `model`.
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
- The answer is untrusted: it must pass the same checks as a recipe's text, and must keep
  each part (name, ingredients, steps) the original had, or it's `bad_result`.

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
