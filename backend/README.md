# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
video links into recipes, and serves the frontend's static build. Read the root
`AGENTS.md` first.

"Current state" and the API tables describe what exists; the sections after them
describe what the backend must do once built. Record new files, schema and endpoints
here in the same PR that adds them.

## Current state

The Worker (`src/index.js`) runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`);
everything else is the static build from `../frontend/out`, served by Cloudflare. The auth
API and the folders/recipes API below exist; video import, translation, password changes
and the admin endpoints don't yet. Run it locally with `npm run dev` (port 8787, after `npm run build` in
`frontend/`). Deploy with `npm run deploy` (`wrangler deploy`), or
automatically through Workers Builds (root directory `/`), which builds with
`cd frontend && npm install && npm run build` and then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production).
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a
  Worker Preview that doesn't replace the production Worker, but shares its database
  (see [Database](#database)). It needs the `"previews": {}` block in
  `wrangler.jsonc`.

Code: `src/index.js` (routes and auth), `src/data.js` (folders and recipes),
`src/http.js` (JSON helpers), `src/session.js` (cookies and the `sessions` table),
`src/password.js` (PBKDF2). Tests: `npm test` (`test/`, Vitest in the Workers runtime on a
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

`user` is `{ id, username, is_admin }`. Cookies (both HttpOnly, SameSite=Lax, 10 years,
`Secure` on https): `device` (random id, kept across logouts) and `session` (random
secret; only its SHA-256 is stored in `sessions.token_hash`). Login upserts the row for the
device. Not built yet: login rate limiting, changing passwords, the admin endpoints.

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

`recipe` is `{ id, folderId, favorite, link, en, he }`, where `en` and `he` are
`{ name, ingredients: [string], steps: [string] }`, `link` is the source video (`''` for
manual recipes) and `folderId` is `null` for "No folder". The backend trims names and
lines and drops blank lines. Limits (`too_long`): recipe name 200 chars, 200 ingredients
or steps per language, 2000 chars per line. Editing a language the LLM filled in clears
`machine_translated_lang`.

The sections below describe what the backend must do once built.

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
- **Imports** are not stored: the models' results go back to the browser for the
  compare screen, and only the recipe the user saves is written (with the model it came
  from).

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
  of `schema.sql`). Users can change their own password (planned).
- Changing or setting a password logs that user out on their other devices.
- After a successful login the user stays logged in on that device and doesn't see the
  login page again, unless they log out, change their password, or the admin deletes
  them. Logins don't expire.
- **One session row per device**: the first login on a browser gives it a long-lived
  device id cookie (kept across logouts). Logging in again on that device replaces its
  row instead of adding one, so rows grow only with new devices. Logging out deletes it.
- Deleting a user logs them out everywhere right away.
- Every API endpoint requires a logged-in user, except sign-up, login and logout. User management and
  starting or stopping impersonation require the admin. While impersonating, recipe and
  folder endpoints use the impersonated user; user management still checks the real
  user (the admin), and the admin can't change the user's password while acting as them.

## Import from a video link

- Supported now: **YouTube and Facebook** links. Other sites get a clear "not supported
  yet" message.
- The backend sends the video to **Google's free-tier LLMs**, which return the recipe in
  English and Hebrew.
- The models to use are configurable. With one model the user gets one result; with
  several, all of them run and the user compares the results and picks one to save.
- If a video has no recipe or can't be read, the user gets a clear message and can add
  the recipe manually. Nothing is saved until the user confirms.
- Provider-specific code stays in one place, so models (or another free provider) can be
  swapped without touching the rest of the backend.

## Translation

When a recipe is written in only one language, the backend fills in the other with the
LLM. The user can correct either version.

## Secrets

The LLM API key exists only in the Worker (a Worker secret, `.dev.vars` locally). Never
send it to the frontend or commit it.

## Deploy

Cloudflare Workers Builds is connected to the GitHub repo and deploys on every merge to
`main`, including the frontend build. Database schema changes are applied to production
by the owner (see [Database](#database)).
