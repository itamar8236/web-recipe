# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
video links into recipes, and serves the frontend's static build. Read the root
`AGENTS.md` first.

"Current state", the API tables and "Import from a YouTube link" describe what exists; the
other sections after them describe what the backend must do once built. Record new files, schema and endpoints
here in the same PR that adds them.

## Current state

The Worker (`src/index.js`) runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`);
everything else is the static build from `../frontend/out`, served by Cloudflare. The auth
API, the folders/recipes API, the YouTube import and translation below exist; the admin
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
choice, usage counting, approvals, reset time), `llm.js` (the only file that knows
Gemini's format), `errors.js`, and `sources/` (link detection and the YouTube adapter). Tests: `npm test` (`test/`, Vitest in the Workers runtime on a
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
| `POST /api/imports` `{url, model?, useBasicModel?}` | Start an import | 202 `{import}`, or 200 with the one already running | 400 `invalid_request`, `link_invalid`, `link_unsupported`; 409 `already_imported`, `model_approval_needed`; 429 `too_many_imports`, `quota` |
| `GET /api/imports` | Cards plus model state | 200 `{imports, models}` | |
| `POST /api/imports/:id/retry` `{useBasicModel?}` | Try a failed import again | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_retryable`, `model_approval_needed`; 429 `quota` |
| `DELETE /api/imports/:id` | Dismiss the card | 200 `{ok}` | 404 |
| `POST /api/recipes/:id/rerun` `{model?, useBasicModel?}` | Scan an imported recipe's video again; replaces its text when done | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_rerunnable` (manual recipe, or that video is running), `model_approval_needed`; 429 `too_many_imports`, `quota` |

- `import` is `{ id, status, stage, link, title, error, retryable, recipeId, recipeName }`.
  `recipeName` is `{ en, he }`, or `null` until there is a recipe. `error` is set only when
  `status` is `failed`.
- `GET` returns `running`, `failed` and `done` rows, newest first, never `dismissed`, and
  never reads `state`. It also marks `running` rows with no update for 30 minutes as failed
  with `timed_out`.
- `models` is `{ bestAvailable, bestLeftToday, bestLeftForUser, basicModel, basicApproved,
  bestAvailableAt, resetsAt }`, times in epoch ms. `bestAvailable` is false when the model
  is out or this user has used their 5. `bestAvailableAt` is `null` while it is available.
- `model` is `'best'` (default) or `'basic'`. Basic skips the best model, needs no approval
  and uses none of the user's 5; a Retry keeps the choice. A re-scan (`rerun`) takes the
  same `model` and `useBasicModel` and follows every rule of a new import (caps, approval,
  the switch on a busy model), except `already_imported`.
- `useBasicModel: true` stores an approval until the next reset.
- POST checks in this order: body, link, a running duplicate, `already_imported`
  (`recipes.source_url`), caps, model state, then insert and start.
- Caps, counted from `imports` for today's `quota_day`: `IMPORT_MAX_RUNNING` (3 running),
  `IMPORT_DAILY_LIMIT` (10 a day) and `IMPORT_BEST_DAILY_PER_USER` (5 on the best model,
  counting best-model translations too).
- A Retry answers `not_retryable` if the same video is already running or saved (for a
  re-scan: if its recipe was deleted). On a later day it counts against that day.

## Translate API

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/translate` `{from, content, model?}` | Translate one language's text into the other | 200 `{content}` | 400 `invalid_request`, `too_long`, `nothing_to_translate`; 429 `best_model_unavailable` (best out), `quota` (basic out); 502 `bad_result`, `llm_error`; 503 `model_busy` |

Needs a session like the rest. `from` is `'en'` or `'he'`, `content` is
`{ name, ingredients, steps }` (same checks and limits as a recipe), `model` is `'best'` or
`'basic'` (default). See [Translation](#translation).

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
- **Imports** are stored in their own `imports` table, so an unfinished one never appears
  as a recipe. A row stays after it finishes, because the daily caps count it. Three small
  tables hold the shared model state: `llm_model_status` (models Google said are out, and
  until when), `llm_usage` (the app's own count per Pacific day and model) and
  `llm_basic_model_approvals` (who accepted the basic model, until when).
  `translation_best_uses` counts each user's best-model translations per Pacific day, since
  they share the 5 daily best-model uses with imports.

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

Users paste a link and go back to YouTube, and a normal request stops when they leave, so
imports run in a **Cloudflare Workflow**. The recipe is written once, complete, with no
folder and no review: the user can edit or delete it afterwards.

```
POST /api/imports {url}
  parse link → guards → choose model → insert imports row → start Workflow → 202

Workflow: each stage is one retried step, and saves its result to the row
  meta     YouTube Data API: title, description, duration, privacy (no LLM)
  extract  One call with the description and, if it can be sent, the video
  save     One D1 batch: insert the recipe, or replace it on a re-scan, + mark the import done
```

**Links.** Only the backend decides which site a link is (`sources/index.js`); the Worker
never fetches the pasted URL. A new platform is one adapter added to `SOURCES`. Every other
site answers `link_unsupported`.

**Extract.** The video is sent if it's at most `IMPORT_MAX_VIDEO_MINUTES` (3) and public.
The description counts if it's at least 80 characters. If neither can be sent, it fails
with no LLM call. One call with whatever can be sent returns the recipe in both languages,
with the video's own language written first. Everything the model returns is untrusted and
is validated before it's stored.

**Models.** `LLM_BEST_MODEL` and `LLM_BASIC_MODEL` are config, so changing one needs no code
change. The best model is tried first whenever it isn't out, up to 5 imports a day per
user. When it's out or the user has used their 5, the user is asked; once they approve, the
basic model is used automatically until the next reset. The user can also pick the basic model
for one import. If the best model is still busy (503) after one short retry, that import moves
to the basic model, with no approval (see Failures). Scanning an existing recipe's video
again (a re-scan, `replace_recipe_id`) follows exactly the same rules.

Every retry keeps the model the import is on: a basic choice (`state.basicChosen`) holds
through Workflow retries, busy waits and a Retry, and never touches the best model.

**Quota.** Daily quotas reset at **midnight Pacific** (`nextQuotaReset`). Google offers no
way to ask how many requests are left, so `llm_usage` counts them: every real call first
reserves one, in one atomic statement, up to `LLM_BEST_DAILY_LIMIT` (20) and
`LLM_BASIC_DAILY_LIMIT` (500). A failed call still counts, because Google may have counted
it, except a 503: Google says a 503 is "unrelated to your quota", so its request is given
back, and so is the user's best-model use if that try took it. Some users report Google
counts them anyway; if so, Google's per-day 429 below sets the count right. A 429
naming a per-day quota marks the model out until the reset and sets its count to the limit.
Any other 429 waits (Google's delay, at most 60 s, otherwise 20 s) and retries once, then
marks the model out for 15 minutes. Quota errors never use Workflow retries.

**Failures.** `error` is written to the row before a stage throws, with the reason in words
in `error_detail` (never sent to the browser).

| Case | Code | Automatic retry | User can Retry |
|---|---|---|---|
| Removed, or Gemini refused the video and nothing else had the recipe | `video_unavailable` | no | no |
| Private or unlisted, description not enough | `video_private` | no | no |
| Too long, description not enough | `video_too_long` | no | no |
| No recipe | `no_recipe` | no | no |
| Several recipes | `multiple_recipes` | no | no |
| Gemini busy (503) | `llm_error` | yes, see below | yes |
| Other 5xx, network, timeout | `llm_error` | yes, 3 tries per stage | yes |
| Invalid output | `bad_result` | yes, 3 tries per stage | yes |
| Best out, no approval | `model_approval_needed` | no | yes |
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
  busy, the import moves to the basic model in that same run, with no approval, and stays
  on it for later runs. The recipe is saved as a basic-model one; the user can scan it
  again from the edit form.
  A Retry starts a new Workflow, so it tries the best model first again.
- **Basic model** (chosen, approved, or after the switch above): every run stays on it.

No wait has jitter: there are too few users for their retries to pile up, and a Workflow
must sleep the same on every replay. Google's Batch API is not used: its results can take
hours, and imports should land in minutes.

A Retry bumps `attempt` and starts a new Workflow. Finished stages are skipped through
`state.done`, so it doesn't depend on how long Workflows keeps its history. Every write is
guarded by `status = 'running'` and the attempt, so a repeated step, a late older attempt or
a dismissal writes nothing, and a recipe is never saved twice.

**Provider.** Everything about Gemini's request format is in `llm.js`, so another free
provider can be swapped in without touching the rest of the backend.

**Limits to keep in mind.** Quota is per Google project and shared by all users, about 20
best-model imports a day in total, and Google says the limits aren't guaranteed. PR previews
can't exercise any of this: a preview's binding uses the Workflow already deployed to
production, and gives `workflow.not_found` before the first deploy.

**Known small gaps**, all rare and harmless:

- "Scan the video again" still shows while that scan is running; tapping it answers
  `not_rerunnable`.
- A Retry that can no longer work says so and leaves the card for the user to dismiss.
- A card left over after the best model is back names the next reset as its time.
- Home can miss one recipe-list reload if an import finishes in the instant between its first
  two requests. Opening the ready card still works.
- A running import dismissed through the raw API (the UI has no × on running cards) may still
  finish its LLM call, but saves nothing.

**Logging.** `llm.js` logs each Gemini request (the model, the video link and the full
prompt) and each failure (the status and Google's error text), never the key. Import prompts
hold only our instructions and a public video description. A translation's prompt holds the
user's own recipe, so it is never logged (`logPrompt: false`). Production keeps the logs for 3
days (Workers Logs, `observability` in `wrangler.jsonc`), and `npx wrangler tail` shows
them live. A failed import also keeps the reason in `imports.error_detail`.

**Testing.** Tests use fake keys and stubs, and `vitest.config.mjs` refuses every outbound
request. Real imports run locally on the dev keys in `.dev.vars`, which use a test quota;
agents test with the Basic model (`local-dev` skill).

## Translation

The edit form's "Translate" sends the language being written to `POST /api/translate`,
which answers with the other language; the form fills it in, and nothing is stored until
the user taps Save. It works for any recipe, manual ones too, but needs an account.

- One plain request, not a Workflow: the user waits for it, and a text-only call takes
  seconds. No video and no link are sent.
- The user picks the model; Basic is the default (the API's and the UI's). A translation
  takes one request from the shared daily count (`llm_usage`). On the best model it also
  takes one of the user's **5 daily best-model uses**, the same 5 imports use: it is counted
  in `translation_best_uses` (a translation has no `imports` row), and every check of the 5
  adds both (`BEST_USES_OF_USER` in `models.js`). Like an import's, the use is given back
  when the model was busy (503) or nothing reached Google, and kept otherwise, even for a
  `bad_result`.
- It needs no approval and never switches model: when the picked one is out, or the user
  has used their 5, it answers `best_model_unavailable` (or `quota` for basic), and the UI
  suggests Basic.
- The answer is untrusted: it must pass the same checks as a recipe's text, and must keep
  each part (name, ingredients, steps) the original had, or it's `bad_result`.

## Secrets

`GEMINI_API_KEY` and `YOUTUBE_API_KEY` exist only in the Worker (Worker secrets;
`.dev.vars` locally, with placeholders in `.dev.vars.example`). Never send them to the
frontend or commit them. Without a key, `llm.js` and `sources/youtube.js` fail at once and
send nothing.

## Deploy

Cloudflare Workers Builds is connected to the GitHub repo and deploys on every merge to
`main`, including the frontend build. Database schema changes are applied to production
by the owner (see [Database](#database)).
