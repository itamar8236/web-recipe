# Architecture

One Cloudflare Worker (`backend/`) serves both the JSON API and the frontend's static build,
so production has one origin: no CORS, no cross-domain cookies. The two apps share no code
and talk only over the [HTTP API](./01_api.md).

```
Browser
   │
   ▼
One Cloudflare Worker  (backend/)
├── /api/*   → JSON API (login required) ──► D1 (users, tags, recipes, pictures, imports)
│                                        ├──► Gemini file store (an uploaded photo, until its import ends)
│                                        └──► Workflow (import, in the background)
│                                               ├──► YouTube Data API (video details)
│                                               ├──► Facebook / Instagram (public post page, video file)
│                                               ├──► Any other public web page (its text)
│                                               ├──► Google LLMs (text + video or photo, or a blocked page's address → recipe)
│                                               ├──► Groq (text-only fallback)
│                                               ├──► Image hosts (the link's one picture)
│                                               └──► Images binding (resizes that picture)
└── /*       → static files built from frontend/ (frontend/out)
```

## Request routing

The Worker runs only for `/api/*` (`run_worker_first` in `backend/wrangler.jsonc`);
everything else is the static build, served by Cloudflare without the Worker. So a path
outside `/api/` never reaches our code: `/__scheduled` gets the static 404 page, for
example. A daily Cron Trigger calls `scheduled()` in `src/index.js` (the Recently deleted
purge, [Data](./02_data.md#recently-deleted)).

## Runtime

The Worker runs with **no `nodejs_compat`**: web APIs only, never `node:*` modules. The
scripts in `backend/scripts/` run on Node and may use them. The Worker can't decode an
image within its CPU time, which is why pictures are resized by the Images binding or in
the browser ([Pictures](./07_pictures.md)).

## Ownership boundaries

Each of these is the only place that knows its subject, so a change stays in one file:

- **`src/index.js`**: routes and the login check. Every `/api/*` route needs a session
  except sign-up, login and logout.
- **`src/data.js`**: every query on a user's tags and recipes is filtered by the acting user.
  `src/browse.js` is the only code that reads another user's recipes.
- **`src/pictures.js`**: the only file that touches picture bytes.
- **`src/import/llm.js`** knows Gemini's request format (and its file store), **`groq.js`**
  Groq's, and **`models.js`** alone decides which model runs and counts the calls
  ([Models](./05_models.md)).
- **`src/import/sources/index.js`** decides which site a link is; `stages.js` knows no site
  ([Import](./04_import.md#links)).
- **`frontend/lib/api.js`** is the frontend's only data layer: the backend for a user,
  memory for a guest ([Web UI](./08_web-ui.md#data-layer)).
- **`frontend/lib/i18n.js`** holds every visible string, in English and Hebrew.

## Static export

The frontend is a Next.js static export (`output: 'export'`). It can't have dynamic route
segments without a build-time list, so a recipe's page takes its id as a query parameter
(`/recipe?id=12`) and fetches on the client. There are no server components that fetch and
no API routes.

## Secrets

`GEMINI_API_KEY`, `YOUTUBE_API_KEY` and the optional `GROQ_API_KEY` exist only in the
Worker (Worker secrets; `.dev.vars` locally, placeholders in `.dev.vars.example`), never
in the frontend. Without a key, `llm.js` and `sources/youtube.js` fail at once and send
nothing; without `GROQ_API_KEY` the fallback model is never used. Facebook and Instagram
need no key. PR previews don't inherit secrets ([Deploy](../operations/01_deploy.md)).
