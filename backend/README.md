# Backend

The server side of web-recipe: one Cloudflare Worker in plain JavaScript that serves the
JSON API, stores data in Cloudflare D1, handles login, calls Google's free LLMs to turn
video links into recipes, and serves the frontend's static build. Read the root
`CLAUDE.md` first.

This file describes **what the backend must do**. Implementation details (file layout,
schema, endpoints) are decided when the code is written, and recorded here in the same PR.

## Current state

The Worker is **assets-only**: `wrangler.jsonc` points at `../frontend/out` and Cloudflare
serves the static build. There is no Worker code, API, database, or login yet; the
frontend runs as an in-memory demo. Run it locally with `npm run dev` (port 8787, after
`npm run build` in `frontend/`). Deploy with `npm run deploy` (`wrangler deploy`), or
automatically through Workers Builds with build command `cd ../frontend && npm install &&
npm run build`, and deploy command `npx wrangler deploy` from `backend/`. The sections
below describe what the backend must do once built.

## Data

- **Users**: up to 50. The owner is the only admin.
- **Folders**: created, renamed, nested, and reordered freely by users.
- **Recipes**: name, source link, ingredients, and instructions, stored in **both English
  and Hebrew** so either version can be edited. A recipe sits in a folder (or none).
  All users share the same folders and recipes.

## Users and login

- No passwords. A user logs in with their username or email only.
- Only the admin can add and delete users. There is no sign-up page.
- After a successful login the user stays logged in on that device and doesn't see the
  login page again, unless they log out, the admin deletes them, or they stay inactive
  for a long time.
- Logins that go unused expire on the server and are cleaned up, so they don't pile up.
- Deleting a user logs them out everywhere right away.
- Every API endpoint requires a logged-in user, except login itself. User management
  requires the admin.

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
`main`, including the frontend build and database migrations.
