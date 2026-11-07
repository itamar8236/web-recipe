# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
video links into recipes, and serves the frontend's static build. Read the root
`CLAUDE.md` first.

This file describes **what the backend must do**. Implementation details (file layout,
schema, endpoints) are decided when the code is written, and recorded here in the same PR.

## Current state

The Worker is **assets-only**: `wrangler.jsonc` points at `../frontend/out` and Cloudflare
serves the static build. There is no Worker code, API, or login yet; the frontend runs as
an in-memory demo. The D1 database is bound (see [Database](#database)) but nothing reads
it yet. Run it locally with `npm run dev` (port 8787, after `npm run build` in
`frontend/`). Deploy with `npm run deploy` (`wrangler deploy`), or
automatically through Workers Builds (root directory `/`), which builds with
`cd frontend && npm install && npm run build` and then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production).
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a
  Worker Preview that doesn't replace the production Worker, but shares its database
  (see the known gap under [Database](#database)). It needs the `"previews": {}` block in
  `wrangler.jsonc`.

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
  touches production. `npm run dev` first runs `npm run db:pull`
  ([`scripts/db-pull.mjs`](scripts/db-pull.mjs)): it exports production (read-only),
  replaces the local database with that copy, then applies `schema.sql` locally.
  `npm run dev:keep` skips the pull and keeps your local test data.
  `db:pull` needs `npx wrangler login` once per machine.
- **Schema**: [`schema.sql`](schema.sql) describes every table. It only uses
  `IF NOT EXISTS`, so applying it again is safe. The owner applies it to production by
  hand: `npx wrangler d1 execute recipes-db --remote --file=schema.sql`.
- The production dump (`.wrangler/prod-dump.sql`) holds real user data: it's git-ignored;
  never commit or paste it.
- Known gap: Workers Builds PR previews (`wrangler preview`) use the same binding, so
  once Worker code reads `env.DB`, previews would read and write production. Give
  previews their own database before that.

## Users and login

- A user logs in with their **username and a password**.
- Passwords are never stored or logged in plain text: only a salted PBKDF2-SHA256 hash
  (WebCrypto, built into Workers), stored with its iterations and salt so the cost can
  be raised later.
- Only the admin can add and delete users. There is no sign-up page. The admin sets a
  user's password when adding them and can set a new one later. Users can change their
  own password.
- Changing or setting a password logs that user out on their other devices.
- After a successful login the user stays logged in on that device and doesn't see the
  login page again, unless they log out, change their password, or the admin deletes
  them. Logins don't expire.
- **One session row per device**: the first login on a browser gives it a long-lived
  device id cookie (kept across logouts). Logging in again on that device replaces its
  row instead of adding one, so rows grow only with new devices. Logging out deletes it.
- Deleting a user logs them out everywhere right away.
- Every API endpoint requires a logged-in user, except login itself. User management and
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
