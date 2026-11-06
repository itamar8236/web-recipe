# Backend

One Cloudflare Worker written in plain JavaScript. It serves the JSON API under `/api/*`,
stores data in Cloudflare D1, handles login, calls Google's LLMs to turn video links into
recipes, and serves the frontend's static build for every other path. Read the root
`CLAUDE.md` first.

## Layout (planned)

```
backend/
├── src/
│   ├── index.js        # Worker entry: auth check, routes /api/* to handlers, else assets
│   ├── auth.js         # Sessions, cookies, requireUser / requireAdmin
│   ├── routes/         # One file per resource: auth.js, users.js, folders.js, recipes.js, import.js
│   ├── db.js           # All SQL lives here (D1 prepared statements only)
│   ├── llm.js          # The only file that talks to an LLM provider
│   ├── sources.js      # Video-link handling per platform (YouTube, Facebook)
│   └── validate.js     # Input validation helpers
├── migrations/         # D1 SQL migrations: 0001_init.sql, ... never edit applied ones
├── test/
├── wrangler.jsonc      # D1 binding "DB", assets dir ../frontend/out, nodejs_compat, vars
├── .dev.vars.example   # Local secrets template (real .dev.vars is git-ignored)
└── package.json
```

- No web framework: `index.js` matches `method + path` with a small switch/regex router.
- Handlers get `(request, env, ctx)` where `ctx.user` is the logged-in user, and return
  `Response.json(...)`.
- Always use bound parameters (`env.DB.prepare(sql).bind(...)`), never string-built SQL.

## Data model

```sql
users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email       TEXT UNIQUE COLLATE NOCASE,          -- optional; either one logs in
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)

sessions (
  token_hash  TEXT PRIMARY KEY,                    -- SHA-256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
)

folders (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = top level
  position    INTEGER NOT NULL DEFAULT 0,                         -- manual ordering
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)

recipes (
  id               INTEGER PRIMARY KEY,
  folder_id        INTEGER REFERENCES folders(id) ON DELETE SET NULL,  -- NULL = unfiled
  source_url       TEXT,                 -- video link, if any
  source_model     TEXT,                 -- LLM model that produced it, if imported
  name_en          TEXT NOT NULL,
  name_he          TEXT NOT NULL,
  ingredients_en   TEXT NOT NULL,        -- JSON array of strings
  ingredients_he   TEXT NOT NULL,        -- JSON array of strings
  instructions_en  TEXT NOT NULL,        -- JSON array of strings (one step each)
  instructions_he  TEXT NOT NULL,        -- JSON array of strings
  position         INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
)
```

- All users share the same folders and recipes; `created_by` is informational only.
- Folders nest to any depth. A recipe sits in one folder (or none).
- Both languages are stored, not translated on the fly, so reads are fast and the user
  can correct either version.
- The API returns arrays as real JSON arrays; `db.js` does the `JSON.parse/stringify`.
- Enable foreign keys in D1 (`PRAGMA foreign_keys = ON` is the D1 default; don't disable).

## Auth

Passwordless and remembered, by the owner's choice: knowing an existing username or email
is enough to log in. Keep usernames non-obvious; this is a deliberate trade-off for a
small private app.

- **Login**: `POST /api/auth/login { identifier }` matches `username` or `email`
  (case-insensitive). On a match, create a random 32-byte token, store its SHA-256 in
  `sessions`, and set cookie `session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/;
  Max-Age=31536000`. No match → 401 with a generic message (don't reveal which part was
  wrong). Add a small delay on failure to slow guessing.
- **Remembered login**: every authenticated request updates `last_seen` (at most once a
  day) and re-sends the cookie with a fresh `Max-Age`, so an active user never expires.
- **Every `/api/*` route requires a valid session** except `POST /api/auth/login`.
  Missing/unknown session → 401. Static files are public (they contain no data).
- **Admin only**: `/api/users*`. The admin can't delete themself. Max **50** users;
  creating the 51st returns 400.
- **Deleting a user** cascades to their sessions, so they're logged out immediately.
- **Logout** deletes the session row and clears the cookie.
- **First admin**: no sign-up page exists. Create the owner once with:
  `npx wrangler d1 execute <db-name> --remote --command "INSERT INTO users (username, email, is_admin) VALUES ('<name>', '<email>', 1)"`
  (use `--local` for local dev).

## API contract

All bodies are JSON. Errors: `{ "error": "human readable message" }` with
400/401/403/404/422/429/500. All routes except login require a session.

| Method | Path                     | Body / query                         | Returns |
|--------|--------------------------|--------------------------------------|---------|
| POST   | `/api/auth/login`        | `{ identifier }`                     | `{ user }` + session cookie |
| POST   | `/api/auth/logout`       |                                      | 204, cookie cleared |
| GET    | `/api/auth/me`           |                                      | `{ user }` (id, username, email, is_admin) or 401 |
| GET    | `/api/users`             | admin                                | list of users |
| POST   | `/api/users`             | admin, `{ username, email? }`        | created user |
| DELETE | `/api/users/:id`         | admin                                | 204 |
| GET    | `/api/folders`           |                                      | flat list of all folders (client builds the tree) |
| POST   | `/api/folders`           | `{ name, parent_id? }`               | created folder |
| PATCH  | `/api/folders/:id`       | `{ name?, parent_id?, position? }`   | updated folder |
| DELETE | `/api/folders/:id`       |                                      | 204; subfolders deleted, their recipes become unfiled |
| GET    | `/api/recipes`           | `?folder_id=` (`none` = unfiled)     | recipe summaries (id, names, folder_id) |
| GET    | `/api/recipes/:id`       |                                      | full recipe |
| POST   | `/api/recipes`           | recipe fields (see below)            | created recipe |
| PUT    | `/api/recipes/:id`       | recipe fields                        | updated recipe |
| DELETE | `/api/recipes/:id`       |                                      | 204 |
| POST   | `/api/recipes/import`    | `{ url }`                            | `{ candidates }` (not saved, see below) |
| POST   | `/api/translate`         | `{ name, ingredients, instructions, to: "en"\|"he" }` | same shape, translated |

Recipe fields: `folder_id`, `source_url`, `source_model`, `name_en`, `name_he`,
`ingredients_en`, `ingredients_he`, `instructions_en`, `instructions_he`. On
create/update, at least one language must be complete; if the other is empty, the backend
fills it via `llm.translate`.

## Import from a video link

Supported platforms: **YouTube** (incl. Shorts) and **Facebook** (videos and reels). Any
other URL returns 400 "This site isn't supported yet". Platform-specific code lives only
in `sources.js`, so adding a platform later is one new function there.

`POST /api/recipes/import` runs synchronously (the UI shows a spinner; 10-60 s is fine)
and **does not save**. It returns candidates for the user to review and save:

1. Validate the URL and detect the platform (`sources.detect(url)`).
2. Build the LLM input (`sources.toLlmInput(url)`):
   - **YouTube**: pass the URL to Gemini as video input (`file_data.file_uri`); the model
     watches the video.
   - **Facebook**: Gemini can't open Facebook links, so fetch the public page and extract
     its title, description, and caption (OpenGraph tags) and send that text. Private or
     login-walled videos yield nothing → 422 "Couldn't read this video, add it manually".
3. Run `llm.extractRecipe(input, model)` for **every configured model in parallel**
   (`Promise.allSettled`), each with a timeout.
4. Each model must return JSON (Gemini structured output with a JSON schema) containing
   both English and Hebrew name, ingredients, and instructions. Validate the shape.
5. Respond with one entry per model:
   ```json
   { "candidates": [
       { "model": "gemini-2.5-flash", "ms": 8200, "recipe": { "name_en": "...", "...": "..." } },
       { "model": "gemma-3-27b-it",  "ms": 5100, "error": "No recipe found in this video" }
   ] }
   ```
   If every model failed, return 422 with the first error.
6. The user picks a candidate (or the only one), may edit it, and the frontend saves it
   with `POST /api/recipes` including `source_url` and `source_model`.

### LLM models

- Only **Google's free-tier models** through the Gemini API (`generativelanguage`
  endpoint, one free API key): e.g. Gemini Flash / Flash-Lite and Gemma. Pick current
  model names when implementing; don't hard-code them in logic.
- `LLM_MODELS` (a `vars` entry in `wrangler.jsonc`, comma-separated, first = default)
  sets which models run. One model → no comparison step. Several → side-by-side compare.
- Translation (`/api/translate` and filling the missing language) uses only the first model.
- Every provider detail (endpoint, prompt, request/response format) stays in `llm.js`
  behind `extractRecipe(input, model)` and `translate(content, to, model)`, so another
  free provider could be added later without touching routes.
- Each model has its own free-tier rate limit. On 429, report that model's candidate as
  "Rate limit reached, try again later" instead of failing the whole import.

## Secrets and config

- `GEMINI_API_KEY`: Worker secret. Local: `.dev.vars`. Production:
  `npx wrangler secret put GEMINI_API_KEY`.
- `LLM_MODELS`, the D1 binding `DB`, and the assets directory live in `wrangler.jsonc`
  (no secrets there).

## Local dev and deploy

- `npm run dev` runs `wrangler dev` with a local D1 on `:8787`. The frontend dev server
  (`:3000`) calls it via `NEXT_PUBLIC_API_BASE=http://localhost:8787`. In local dev only,
  the Worker allows CORS from `http://localhost:3000` with
  `Access-Control-Allow-Credentials: true` so the session cookie works.
- Deploy: Cloudflare Workers Builds is connected to the GitHub repo. On merge to `main` it
  builds the frontend (`frontend/out`), applies D1 migrations, and deploys the Worker.
