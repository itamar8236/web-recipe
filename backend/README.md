# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
YouTube, Facebook and Instagram links into recipes, and serves the frontend's static build. Read the root
`AGENTS.md` first.

"Current state", the API tables and "Import from a YouTube link" describe what exists; the
other sections after them describe what the backend must do once built. Record new files, schema and endpoints
here in the same PR that adds them.

## Current state

The Worker (`src/index.js`) runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`);
everything else is the static build from `../frontend/out`, served by Cloudflare. The auth
API, the folders/recipes API, the import from a link and translation below exist; the admin
endpoints don't yet. Run it locally with `npm run dev` (port 8787, after `npm run build` in
`frontend/`). Deploy with `npm run deploy` (`wrangler deploy`), or
automatically through Workers Builds (root directory `/`), which builds with
`cd frontend && npm install && npm run build` and then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production).
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a
  Worker Preview that doesn't replace the production Worker, but shares its database
  (see [Database](#database)). It needs the `previews` block in
  `wrangler.jsonc`.

Code: `src/index.js` (routes and auth), `src/data.js` (folders and recipes),
`src/imports.js` (import endpoints), `src/translate.js` (translation), `src/http.js` (JSON helpers), `src/session.js`
(cookies and the `sessions` table), `src/password.js` (PBKDF2), and `src/import/`:
`workflow.js` (the background job), `stages.js` (what each stage does), `models.js` (model
choice, usage counting, reset time), `llm.js` (the only file that knows
Gemini's format, including its file store for videos), `groq.js` (the only file that knows
Groq's format, for the fallback model), `errors.js`, and `sources/` (link detection and one
adapter per site: `youtube.js`, `facebook.js`, `instagram.js`, with `meta.js` for what the
last two share). `scripts/e2e-links.mjs` runs real imports through the local app by hand. Tests: `npm test` (`test/`, Vitest in the Workers runtime on a
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
| `PUT /api/auth/me` `{username?, password?}` | Change your own username and/or password (at least one; the old password is not asked for). Every existing login stays, on this device and the others | 200 `{user}` | 400 `invalid_request`, `username_invalid`, `password_invalid` (same limits as sign-up), 409 `username_taken`, 401 `not_logged_in` |

`user` is `{ id, username, is_admin }`. Cookies (both HttpOnly, SameSite=Lax, 10 years,
`Secure` on https): `device` (random id, kept across logouts) and `session` (random
secret; only its SHA-256 is stored in `sessions.token_hash`). Login upserts the row for the
device. Not built yet: login rate limiting, the admin endpoints.

## Folders and recipes API

All need a session (401 `not_logged_in` otherwise) and work only on the data of the user
the session acts for (`COALESCE(sessions.acting_as_user_id, sessions.user_id)`, so admin
impersonation will just work once it can be started). Another user's folder or recipe
answers 404, exactly like one that doesn't exist. Bodies must be JSON with
`Content-Type: application/json` (400 `invalid_request` otherwise). A path that exists
with the wrong method answers 405 `method_not_allowed`.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/folders` | The user's folders, oldest first | 200 `{folders: [{id, name}]}` | |
| `POST /api/folders` `{name}` | Create a folder | 201 `{folder}` | 400 `name_required`, `too_long` (> 100 chars) |
| `PUT /api/folders/:id` `{name}` | Rename | 200 `{folder}` | 400 as above, 404 `not_found` |
| `DELETE /api/folders/:id` | Delete an empty folder | 200 `{ok}` | 409 `folder_not_empty`, 404 |
| `GET /api/recipes` | All the user's recipes, oldest first | 200 `{recipes: [recipe]}` | |
| `GET /api/recipes/:id` | One recipe | 200 `{recipe}` | 404 |
| `POST /api/recipes` `{folderId, en, he}` | Create a manual recipe | 201 `{recipe}` | 400 `name_required` (no name in either language), `too_long`, `folder_not_found` |
| `PUT /api/recipes/:id` `{folderId, en, he}` | Replace its text and folder (favorite and link are kept) | 200 `{recipe}` | 400 as above, 404 |
| `PUT /api/recipes/:id/favorite` `{favorite: true\|false}` | Set (not toggle) the favorite | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `DELETE /api/recipes/:id` | Delete | 200 `{ok}` | 404 |

`recipe` is `{ id, folderId, favorite, link, sourceModel, en, he }`, where `en` and `he` are
`{ name, ingredients: [string], steps: [string] }`, `link` is the source video (`''` for
manual recipes), `sourceModel` is the LLM that produced it (`null` for manual recipes) and
`folderId` is `null` for "No folder". The backend trims names and
lines and drops blank lines. Limits (`too_long`): recipe name 200 chars, 200 ingredients
or steps per language, 2000 chars per line. Editing a language the LLM filled in clears
`machine_translated_lang`.

## Import API

All need a session, work only on the data of the user the session acts for, and answer
404 for another user's import or recipe, like the API above. POST bodies must be JSON.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/imports` `{url, model?}` | Start an import | 202 `{import}`, or 200 with the one already running | 400 `invalid_request`, `link_invalid`, `link_unsupported`; 409 `already_imported`; 429 `too_many_imports`, `quota` |
| `GET /api/imports` | Cards plus model state | 200 `{imports, models}` | |
| `POST /api/imports/:id/retry` `{}` | Try a failed import again, as a new import | 202 `{import}` (the new one) | 400 `invalid_request`; 404; 409 `not_retryable`; 429 `too_many_imports`, `quota` |
| `DELETE /api/imports/:id` | Dismiss the card | 200 `{ok}` | 404 |
| `POST /api/recipes/:id/rerun` `{model?}` | Scan an imported recipe's video again; replaces its text when done | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_rerunnable` (manual recipe, or that video is running); 429 `too_many_imports`, `quota` |

- `import` is `{ id, status, stage, link, title, error, retryable, recipeId, recipeName }`.
  `stage` is `meta`, `video`, `extract` or `save`. `link` is the stored link, which for a
  share link changes to the post's own link once the import has followed it.
  `recipeName` is `{ en, he }`, or `null` until there is a recipe. `error` is set only when
  `status` is `failed`.
- `GET` returns `running`, `failed` and `done` import rows, newest first, never `dismissed`
  or translations, and never reads `state`. It also marks `running` rows with no update for 30 minutes as failed
  with `timed_out`.
- `models` is `{ bestAvailable, bestLeftToday, bestLeftForUser, basicModel,
  bestAvailableAt, resetsAt }`, times in epoch ms. `bestAvailable` is false when the shared
  count is used up or this user has used their 5; both are daily, so `bestAvailableAt` is
  then the reset, and `null` while it is available.
- `model` is `'best'` (default) or `'basic'`. With best, the basic model is used by itself
  when the best one can't be (nobody is asked). Basic never tries the best model and uses
  none of the user's 5; a Retry keeps the choice. A re-scan (`rerun`) takes the same `model`
  and follows every rule of a new import, except `already_imported`. An older page's
  `useBasicModel` field is ignored.
- POST checks in this order: body, link, a running duplicate, `already_imported`
  (`recipes.source_url`), caps, model state (only both models out stops it), then insert
  and start.
- Caps, counted from today's `quota_day`: `IMPORT_MAX_RUNNING` (3 running) and
  `IMPORT_DAILY_LIMIT` (10 a day) count import rows, so every Retry and re-scan too, but not
  translations. `IMPORT_BEST_DAILY_PER_USER` (5) counts every row with `used_best = 1`,
  translations included.
- A Retry is a **new row**: it copies the failed row's link, title and model choice, starts
  over from the first stage in its own Workflow, and the failed row becomes `dismissed`.
  Only a failed save keeps its `state` and stage, since it already holds the recipe. It answers `not_retryable` if the same video is already running or saved
  (for a re-scan: if its recipe was deleted). A failed `model_approval_needed` row (from
  before approvals were dropped) can be retried and just runs.

## Translate API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/translate` `{from, content, model?, recipeId?}` | Translate one language's text into the other | 200 `{content, model}` | 400 `invalid_request`, `too_long`, `nothing_to_translate`; 404 (another user's recipe); 429 `quota` (no model can run); 502 `bad_result`, `llm_error`; 503 `model_busy` (the basic model is busy) |

Needs a session like the rest. `from` is `'en'` or `'he'`, `content` is
`{ name, ingredients, steps }` (same checks and limits as a recipe), `model` is `'best'` or
`'basic'` (default), `recipeId` is the recipe being edited (omit for one not saved yet).
The answer's `model` (`'best'` or `'basic'`) says which one answered. See
[Translation](#translation).

The sections below describe what the backend must do once built, except "Import from a
YouTube link", which exists.

## Data

- **Users**: up to 50. The owner is the only admin.
- **Every user has their own private folders and recipes.** No other user sees or
  changes them, and every query is filtered by the user the session acts for.
- **Admin impersonation**: the admin can "act as" any user and then sees and changes
  that user's folders and recipes exactly as they would, until tapping "Stop". It is
  stored on the admin's session (`sessions.acting_as_user_id`), so it doesn't affect the
  user's own devices, and the database refuses it for anyone but the admin.
- **Deleting a user deletes everything of theirs**: sessions, folders, and recipes.
- **Folders**: a flat list per user, created, renamed, and deleted (only when empty).
- **Recipes**: name, source link, ingredients, and instructions, stored in **both English
  and Hebrew** so either version can be edited. A recipe sits in one of its owner's
  folders (or none). A favorite is a flag on the recipe, since only its owner sees it.
- **Model requests** live in the `llm_requests` table: **one row per request** a user
  makes, with a `purpose`: `import` (a new import, each Retry, each re-scan) or `translation` (linked to the recipe by `recipe_id`). So an
  unfinished import never appears as a recipe, and the rows are the record of who used the
  models: a user's daily best-model uses are their rows with `used_best = 1`. A row stays
  after it finishes, because the caps count it. `llm_usage` holds the app's own count of
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
- **Changing an existing table** needs a one-off file in [`migrations/`](migrations), run
  once by the owner on production (each file says how at its top). `schema.sql` can't do
  it: it only creates what is missing.
- **Schema**: [`schema.sql`](schema.sql) describes every table. It only uses
  `IF NOT EXISTS`, so applying it again is safe. The owner applies it to production by
  hand: `npx wrangler d1 execute recipes-db --remote --file=schema.sql`.
- The production dump (`.wrangler/prod-dump.sql`) holds real user data: it's git-ignored;
  never commit or paste it.
- PR previews (`wrangler preview`) use the same binding, so a preview that someone uses
  reads and writes production. Accepted for now: nobody else gets the preview links, and
  a separate preview database may come later. It's a concern only if a PR would change
  production data during the build or deploy itself (see the `local-dev` skill).

## Users and login

- A user logs in with their **username and a password**.
- Passwords are never stored or logged in plain text: only a salted PBKDF2-SHA256 hash
  (WebCrypto, built into Workers), stored with its iterations and salt so the cost can
  be raised later.
- Anyone can sign up (`/api/auth/register`) while fewer than 50 users exist. Only the admin
  deletes users (planned). The first admin is created by hand on production (see the top
  of `schema.sql`). Users change their own username and password
  (`PUT /api/auth/me`), without typing the old password: the owner chose that, since the
  session already proves who it is. It always changes the real logged-in user, even while
  the admin is acting as someone else.
- Changing your own username or password keeps every login you already have (on all
  devices); the new details are needed only for the next login.
- After a successful login the user stays logged in on that device and doesn't see the
  login page again, unless they log out or the admin deletes
  them. Logins don't expire.
- **One session row per device**: the first login on a browser gives it a long-lived
  device id cookie (kept across logouts). Logging in again on that device replaces its
  row instead of adding one, so rows grow only with new devices. Logging out deletes it.
- Deleting a user logs them out everywhere right away.
- Every API endpoint requires a logged-in user, except sign-up, login and logout. User management and
  starting or stopping impersonation require the admin. While impersonating, recipe and
  folder endpoints use the impersonated user; user management still checks the real
  user (the admin), and the admin can't change the user's password while acting as them.

## Import from a YouTube link

(The heading is kept for the links that point here; it covers all three sites.)

Users paste a link and go back to the video, and a normal request stops when they leave, so
imports run in a **Cloudflare Workflow**. The recipe is written once, complete, with no
folder and no review: the user can edit or delete it afterwards.

```
POST /api/imports {url}
  parse link → guards → choose model → insert llm_requests row → start Workflow → 202

Workflow: each stage is one retried step, and saves its result to the row
  meta     The post's details from its site: title, text, subtitles, video facts (no LLM)
  video    Facebook and Instagram only: stream the video file into Gemini's file store
  extract  One call with the text and, if it can be sent, the video
  save     One D1 batch: insert the recipe, or replace it on a re-scan, + mark the import done
```

**Links.** Only the backend decides which site a link is (`sources/index.js`), from the
link's text alone. A new platform is one adapter added to `SOURCES` (the adapter shape is
described at the top of that file); `stages.js` knows no site. Every other site answers
`link_unsupported`, and a link on a known site that isn't a post answers `link_invalid`.
The stored link is always rebuilt from the parsed id, so tracking parameters are dropped
and every form of one post is the same import.

- YouTube: `watch?v=`, `youtu.be/`, `shorts/`, `live/`.
- Facebook (`facebook.com`, `www.`, `m.`, `web.`, `fb.watch`): `/reel/<id>`,
  `/watch?v=<id>`, `/video.php?v=<id>`, `/<page>/videos/[<title>/]<id>`, stored as
  `https://www.facebook.com/watch/?v=<id>`. Share links: `/share/<code>`,
  `/share/v|r|p/<code>`, `fb.watch/<code>`.
- Instagram (`instagram.com`, `www.`, `instagr.am`): `[/<user>]/reel|reels|p|tv/<code>`,
  stored as `https://www.instagram.com/p/<code>/`. Share links: `/share/[reel|p/]<code>`.

**The Worker never fetches a pasted URL as it is.** It fetches only URLs it builds from the
parsed id, with `redirect: 'manual'`, and follows each redirect by hand only onto the
site's own hosts (`fetchPage` in `sources/meta.js`). Video and subtitle files are fetched
only from Meta's CDN (`*.fbcdn.net`, `*.cdninstagram.com`), and the upload address Gemini
answers with is used only on Google's own host.

**Share links.** A share link doesn't say which post it is, so it starts as its own id
(`share/r/<code>`). The `meta` stage follows it, writes the post's real id and link on the
row, and then does the duplicate checks a normal link gets before starting: if the user
already has that recipe the card fails with `already_imported`, and if the same post is
already being imported (the unique index) the newer row dismisses itself. A share link that
leads to something that isn't a video or post fails with `link_unsupported`.

**Facebook and Instagram.** Both are read the way an anonymous visitor's browser reads a
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

**Models.** `LLM_BEST_MODEL` and `LLM_BASIC_MODEL` are config, so changing one needs no code
change. Nobody is ever asked to approve the basic model. The best model is tried first
while the user has some of their 5 left and the shared count isn't used up; otherwise the
basic model is used by itself until the reset. The user can also pick the basic model for
one import. If the best model is still busy (503) after one short retry, that import moves
to the basic model (see Failures). Scanning an existing recipe's video again (a re-scan,
`replace_recipe_id`) follows exactly the same rules.

**Fallback model.** `LLM_FALLBACK_MODEL` (`openai/gpt-oss-120b` on Groq's free tier) answers
when the basic model is busy (503) or out for the day, for requests with **no video**: a
translation, or an import that has only text to send. It can't watch a video, so a request
with one still waits for Gemini as described under Failures. It is off until
`GROQ_API_KEY` is set, and then has its own daily count (`LLM_FALLBACK_DAILY_LIMIT`, 200;
Groq's free limit when checked was 1,000 requests and 200,000 tokens a day, 8,000 tokens a
minute). A recipe it wrote has its name in `source_model`; the translate API still answers
`model: 'basic'`. Users still see only Best and Basic.

**The user's 5.** A row takes one of the 5 (`used_best = 1`, in one statement, so two rows
can't take the last one) when it is about to call the best model, and keeps it once a
request reached Google, even if the model was busy or answered with a quota error and the
row ended up on the basic model: trying the best model is what the 5 count. A row calls the
model more than once (Workflow retries, busy waits, a second ask without the video) but
takes the use only once. It is given back only when nothing was sent (the shared count was
already used up).

Every retry keeps the model the import is on: a basic choice (`state.basicChosen`) holds
through Workflow retries, busy waits and a Retry, and never touches the best model.

**Quota.** Daily quotas reset at **midnight Pacific** (`nextQuotaReset`). Google offers no
way to ask how many requests are left, so `llm_usage` counts them: every real call first
reserves one, in one atomic statement, up to `LLM_BEST_DAILY_LIMIT` (20) and
`LLM_BASIC_DAILY_LIMIT` (500). A failed call still counts, because Google may have counted
it, except a 503: Google says a 503 is "unrelated to your quota", so its request is given
back to this shared count (not to the user's 5, see above). Some users report Google
counts them anyway; if so, Google's per-day 429 below sets the count right. A 429
naming a per-day quota sets the model's count to the limit, which alone keeps it unused
until the reset; the request moves to the basic model at once. Any other 429 (a per-minute
limit) waits (Google's delay, at most 60 s, otherwise 20 s) and retries once, then that
request moves to the basic model; nothing is remembered, so the next request simply tries.
Quota errors never use Workflow retries.

**Failures.** `error` is written to the row before a stage throws, with the reason in words
in `error_detail` (never sent to the browser).

| Case | Code | Automatic retry | User can Retry |
|---|---|---|---|
| Removed or private, or the video couldn't be used and nothing else had the recipe | `video_unavailable` | no | no |
| The site redirected to a login page, or shows the post only after a login | `login_required` | no | yes |
| The site answered 403/429/5xx, or sent a page with none of the known parts | `source_blocked` | yes, 3 tries | yes |
| A share link led to a recipe the user already has | `already_imported` | no | no |
| A share link led to something that isn't a video or post | `link_unsupported` | no | no |
| Private or unlisted, description not enough | `video_private` | no | no |
| Too long, description not enough | `video_too_long` | no | no |
| No recipe | `no_recipe` | no | no |
| Several recipes | `multiple_recipes` | no | no |
| Gemini busy (503) | `llm_error` | yes, see below | yes |
| Other 5xx, network, timeout | `llm_error` | yes, 3 tries per stage | yes |
| Invalid output | `bad_result` | yes, 3 tries per stage | yes |
| Both out | `quota` | no | yes |
| Stuck for 30 minutes | `timed_out` | no | yes |

Each stage may take 15 minutes; a Gemini request is cancelled after 14, so a retry never
overlaps a call that is still running (video calls have taken over 5 minutes).

A busy model (503, "high demand") can stay busy for minutes or hours, so it skips those
quick retries and follows Google's advice instead: back off and retry, short at first and
longer after. The stage ends without failing, and the Workflow sleeps (`step.sleep`) **30
seconds, then 2 minutes, then 8 minutes** before each new run, so 4 runs in all; still busy
after that, it fails with `llm_error`. The card shows the import as still running
meanwhile. The Workflow passes the number of waits so far to the stage (`busyWaits`), which
picks the model:

- **Best model:** its first retry, after 30 seconds, stays on the best model. If it's still
  busy, the import moves to the basic model in that same run and stays on it for later
  runs; the row keeps its best-model use. The recipe is saved as a basic-model one; the
  user can scan it again from the edit form. A Retry is a new row and a new Workflow, so it
  tries the best model first again (and takes another use).
- **Basic model** (chosen, or after the switch above): every run stays on it.

No wait has jitter: there are too few users for their retries to pile up, and a Workflow
must sleep the same on every replay. Google's Batch API is not used: its results can take
hours, and imports should land in minutes.

A Retry inserts a new row and starts a new Workflow from the first stage, keeping only the
model choice (`state.basicChosen`). It doesn't reuse what the earlier stages left, because
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

**Limits to keep in mind.** Quota is per Google project and shared by all users, about 20
best-model imports a day in total, and Google says the limits aren't guaranteed. PR previews
can't exercise any of this: a preview's binding uses the Workflow already deployed to
production, and gives `workflow.not_found` before the first deploy.

**Known small gaps**, all rare and harmless:

- "Scan the video again" still shows while that scan is running; tapping it answers
  `not_rerunnable`.
- A Retry that can no longer work says so and leaves the card for the user to dismiss.
- Home can miss one recipe-list reload if an import finishes in the instant between its first
  two requests. Opening the ready card still works.
- A running import dismissed through the raw API (the UI has no × on running cards) may still
  finish its LLM call, but saves nothing.
- An uploaded video stays in Gemini's file store until Google deletes it (48 hours) when
  its import fails before a usable answer. A Retry uploads the video again.
- When both Gemini models are out for the day a new import is refused with `quota` before
  it starts, even if the fallback model could have read its text.

**Logging.** `llm.js` logs each Gemini request (the model, the video link and the full
prompt) and each failure (the status and Google's error text), never the key. Import prompts
hold only our instructions and a public video description. A translation's prompt holds the
user's own recipe, so it is never logged (`logPrompt: false`). Production keeps the logs for 3
days (Workers Logs, `observability` in `wrangler.jsonc`), and `npx wrangler tail` shows
them live. A failed import also keeps the reason in `llm_requests.error_detail`.

**Testing.** Tests use fake keys and stubs, and `vitest.config.mjs` refuses every outbound
request. Real imports run locally on the dev keys in `.dev.vars`, which use a test quota;
agents test with the Basic model (`local-dev` skill).

## Translation

The edit form's "Translate" sends the language being written to `POST /api/translate`,
which answers with the other language; the form fills it in, and nothing is stored until
the user taps Save. It works for any recipe, manual ones too, but needs an account.

- One plain request, not a Workflow: the user waits for it, and a text-only call takes
  seconds. No video and no link are sent.
- Each translation is an `llm_requests` row with `purpose = 'translation'`, inserted before the
  call (status `running`, then `done` or `failed` with its `error`), with `recipe_id` set to
  the recipe being edited (`NULL` for one not saved yet) and the answering model in `state`.
  The recipe text itself is never stored there. Translations never show as cards and don't
  count toward the import caps.
- The user picks the model; Basic is the default (the API's and the UI's). A translation
  takes one request from the shared daily count (`llm_usage`). On the best model the row
  takes one of the user's **5 daily best-model uses**, exactly like an import's (see "The
  user's 5").
- Nobody is asked and nothing waits, since the user is waiting: if the best model was
  picked but the user has used their 5, the shared count is used up, it's busy, or it hit
  a quota error, the basic model answers at once, and the answer's `model` says so (the UI
  then notes it). Only a busy basic model (`model_busy`) or both models out (`quota`) fail.
- The answer is untrusted: it must pass the same checks as a recipe's text, and must keep
  each part (name, ingredients, steps) the original had, or it's `bad_result`.

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
