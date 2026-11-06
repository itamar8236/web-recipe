# Backend

One Cloudflare Worker written in plain JavaScript. It serves the JSON API under `/api/*`,
stores data in Cloudflare D1, calls the Gemini API to turn video links into recipes, and
serves the frontend's static build for every other path. Read the root `CLAUDE.md` first.

## Layout (planned)

```
backend/
├── src/
│   ├── index.js        # Worker entry: routes /api/* to handlers, everything else to assets
│   ├── routes/         # One file per resource: folders.js, recipes.js, import.js
│   ├── db.js           # All SQL lives here (D1 prepared statements only)
│   ├── llm.js          # The only file that talks to an LLM provider
│   └── validate.js     # Input validation helpers
├── migrations/         # D1 SQL migrations: 0001_init.sql, 0002_..., never edit applied ones
├── test/
├── wrangler.jsonc      # D1 binding "DB", assets dir ../frontend/out, nodejs_compat
├── .dev.vars.example   # Local secrets template (real .dev.vars is git-ignored)
└── package.json
```

- No web framework: `index.js` matches `method + path` with a small switch/regex router.
- Handlers get `(request, env, params)` and return `Response.json(...)`.
- Always use bound parameters (`env.DB.prepare(sql).bind(...)`), never string-built SQL.

## Data model

```sql
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
  name_en          TEXT NOT NULL,
  name_he          TEXT NOT NULL,
  ingredients_en   TEXT NOT NULL,        -- JSON array of strings
  ingredients_he   TEXT NOT NULL,        -- JSON array of strings
  instructions_en  TEXT NOT NULL,        -- JSON array of strings (one step each)
  instructions_he  TEXT NOT NULL,        -- JSON array of strings
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
)
```

- Folders nest to any depth. A recipe sits in one folder (or none).
- Both languages are stored, not translated on the fly, so reads are fast and the user
  can correct either version.
- The API returns arrays as real JSON arrays; `db.js` does the `JSON.parse/stringify`.

## API contract

All bodies are JSON. Errors: `{ "error": "human readable message" }` with 400/404/500.

| Method | Path                     | Body / query                         | Returns |
|--------|--------------------------|--------------------------------------|---------|
| GET    | `/api/folders`           |                                      | flat list of all folders (client builds the tree) |
| POST   | `/api/folders`           | `{ name, parent_id? }`               | created folder |
| PATCH  | `/api/folders/:id`       | `{ name?, parent_id?, position? }`   | updated folder |
| DELETE | `/api/folders/:id`       |                                      | 204; subfolders deleted, their recipes become unfiled |
| GET    | `/api/recipes`           | `?folder_id=` (`none` = unfiled)     | recipe summaries (id, names, folder_id) |
| GET    | `/api/recipes/:id`       |                                      | full recipe |
| POST   | `/api/recipes`           | recipe fields (see below)            | created recipe |
| PUT    | `/api/recipes/:id`       | recipe fields                        | updated recipe |
| DELETE | `/api/recipes/:id`       |                                      | 204 |
| POST   | `/api/recipes/import`    | `{ url, folder_id? }`                | created recipe (from the video) |
| POST   | `/api/translate`         | `{ name, ingredients, instructions, to: "en"\|"he" }` | same shape, translated |

Recipe fields: `folder_id`, `source_url`, `name_en`, `name_he`, `ingredients_en`,
`ingredients_he`, `instructions_en`, `instructions_he`. On create/update, at least one
language must be complete; if the other is empty, the backend fills it via
`llm.translate`. Update this table in the same PR as any API change.

## Import from a video link

`POST /api/recipes/import` runs synchronously (the UI shows a spinner; 10-60 s is fine):

1. Validate the URL (http/https, length limit).
2. `llm.extractRecipe(url)`:
   - **YouTube** (incl. Shorts): pass the URL to Gemini as video input; it watches it.
   - **Other sites** (Instagram, TikTok, ...): fetch the page, take its title, description,
     and caption (OpenGraph / oEmbed), and send that text to Gemini.
3. Gemini must return JSON (use its structured-output / JSON schema mode) with both
   English and Hebrew versions of name, ingredients, and instructions.
4. Validate the JSON shape; if it's invalid or the video has no recipe, return 422 with a
   clear message. Never save a partial recipe.
5. Save and return the recipe. The user can then edit it like any other.

Keep every provider detail (model name, prompt, request format) inside `llm.js`, so
switching to another free provider (e.g. Groq, Cloudflare Workers AI) touches one file.
Use a current free-tier Flash model and handle 429 (rate limit) with a friendly error.

## Secrets and config

- `GEMINI_API_KEY`: Worker secret. Local: `.dev.vars`. Production:
  `npx wrangler secret put GEMINI_API_KEY`.
- D1 binding `DB` and the assets directory are set in `wrangler.jsonc` (no secrets there).

## Auth

Cloudflare Access protects the app's domain with an email allow-list, so the Worker
contains no login code. Disable the `workers.dev` URL (or protect it too) so nothing
bypasses Access. Locally there is no auth.

## Local dev and deploy

- `npm run dev` runs `wrangler dev` with a local D1 on `:8787`. The frontend dev server
  (`:3000`) calls it via `NEXT_PUBLIC_API_BASE=http://localhost:8787`, so in local dev
  only, the Worker allows CORS from `http://localhost:3000`.
- Deploy: Cloudflare Workers Builds is connected to the GitHub repo. On merge to `main` it
  builds the frontend (`frontend/out`), applies D1 migrations, and deploys the Worker.
