# Import

How a link or photos become a recipe: one Cloudflare Workflow in `backend/src/import/`.
Endpoints are in [API → Imports](./01_api.md#imports); which model runs is
[Models and quota](./05_models.md).

Users paste a link and go back to the video, and a normal request stops when they leave,
so imports run in a **Workflow**. The recipe is written once, complete, with no tags and
no review: the user edits or deletes it afterwards.

```
POST /api/imports {url}
  parse link → guards → choose model → insert llm_requests row → start Workflow → 202

Workflow: each stage is one retried step, and saves its result to the row
  meta     The post's details from its site: title, text, subtitles, video facts (no LLM);
           for a web page, its title and text
  video    Facebook and Instagram only: stream the video file into Gemini's file store
  extract  One call with the text and, if it can be sent, the video; the same call
           gives the calories and protein per serving
  save     One D1 batch: insert the recipe (or replace it on a re-scan) + mark the import
           done (+ a photo import's chosen picture becomes the recipe's)
  picture  After the import is done: the link's picture (never fails the import)
```

## Links

Only the backend decides which site a link is (`sources/index.js`), from the link's text
alone. A new platform is one adapter added to `SOURCES` (its shape is described at the top
of that file). Any other link is a web page (`web.js`, the last adapter), unless
`isFetchableUrl` refuses it (`link_unsupported`). A link on a known site that isn't a post
is `link_invalid`, never a web page. The stored link is **rebuilt from the parsed id** (for
a web page: without its `#fragment` and tracking parameters such as `utm_*` and `fbclid`),
so every form of one post is the same import. The accepted forms are in each adapter.

**What the Worker fetches.** A pasted URL is fetched as it is only for a web page. For the
three sites it fetches only URLs it builds from the parsed id, with `redirect: 'manual'`,
following each redirect by hand only onto the site's own hosts (`fetchPage` in
`sources/meta.js`). Video and subtitle files come only from Meta's CDN (`*.fbcdn.net`,
`*.cdninstagram.com`), and the upload address Gemini answers with is used only on Google's
own host.

**Share links** (`/share/...`, `fb.watch/...`) don't say which post they are, so the row
starts with the share code as its id. The `meta` stage follows it, writes the post's real id
and link on the row, and only then does the duplicate checks a normal link gets: the user
already has it → `already_imported`; the same post is already running (the unique index) →
the newer row dismisses itself; it isn't a video or post → `link_unsupported`. From some
networks (Cloudflare's among them) Facebook sends a public video's share link to its login
page; when that page's `next` parameter is the video's link, the import reads the video from
its own page and goes on. Otherwise it fails with `login_required`, and `error_detail` keeps
the login page's full address.

## Web pages

Any public page with a recipe (`sources/web.js`). There is no id to rebuild the link from,
so the pasted link itself is fetched, and that is guarded:

- `isFetchableUrl` checks the link and **every redirect hop**, followed by hand (at most 5,
  onto any public host, since sites often move to `www.`): http or https, the default port,
  no `user:pass@`, and a real domain name, never an IP address (the URL parser turns every
  numeric form into one), `localhost` or a private-network name. Cloudflare's own fetch
  can't reach private addresses either.
- One request with a browser's headers, a timeout, a size cap, and only HTML or plain text;
  anything else is `link_unsupported`. The only other thing fetched is the page's one
  preview image, with the same checks ([Pictures](./07_pictures.md)).
- **No proxies, scraping services, logins or CAPTCHA solvers**, here or for any site.
- The model gets what a reader sees: scripts, styles, menus, footers, sidebars and buttons
  dropped, one block per line, capped in length. A schema.org `Recipe` block (JSON-LD) goes
  first when it has ingredients and steps, followed by the page text anyway, since such
  blocks often leave a part out (a topping's ingredients).
- The prompt says menus, ads, comments and other recipes' titles are not the recipe. No
  recipe → `no_recipe`, several → `multiple_recipes`, too little text → `no_recipe` with no
  model call.
- **A page that turns the Worker away (403 or 429)** is opened by the model itself, with
  Google's URL context tool: many sites' bot protection blocks Cloudflare's addresses but
  not Google's. The Worker sends only the address (the last hop, which passed
  `isFetchableUrl`), and never to the fallback model, which has no such tool. Unless Google
  reports that it opened the page, the answer is not used and the import ends as
  `source_blocked` with no retry and no other model, since any of them would open it the
  same way. A `share.google` link can't be opened this way, so the Worker's own redirects
  lead the model to the real page.

## Facebook and Instagram

Read the way an anonymous visitor's browser reads a public post: one page request with a
browser's headers (Facebook answers 400 without them), **no account, cookies, tokens,
proxies or scraping services**. The post's data is in `<script type="application/json">`
blocks; only the blocks that mention the post are parsed, and facts are found by field name
and the post's id, not by a fixed path, because a reel page and a watch page differ.

- Facebook: the caption, length, a video file and sometimes an auto-made subtitle track.
  Videos and reels only.
- Instagram: the caption, a video file and its length. A photo or carousel post has no
  video and is read from its caption.
- A page without its data blocks still gives the link-preview text as a caption-only import.
- Built and tested from a home connection. Cloudflare's network may be answered with a
  login wall or a block (`login_required`, `source_blocked`, reason in `error_detail`), and
  Meta can change its pages at any time; `scripts/e2e-links.mjs` is the check (`local-dev`).
- **Instagram's login wall comes and goes** from Cloudflare's network: a public post may
  show it on one try and not the next. So an Instagram login wall (a redirect to its login
  page, the login page itself, or a post shown only after a login) gets the same waits as
  a busy model ([Models → Busy models](./05_models.md#busy-models)) and fails with
  `login_required` only after the last one.

## Import from photos

**1 to 7 pictures of one written recipe** (cookbook pages, screenshots, a handwritten card,
and maybe a photo of the dish), from "Choose photos" or the Android Share menu
([Web UI → Share](./08_web-ui.md#share)); the backend can't tell the two apart. They go
through the same Workflow, are read together in **one** model request, and are saved like a
link's recipe.

```
POST /api/imports/photo   multipart `photo` parts in order, header X-Photo-Count
  guards: session, count matches the parts, 1-7, total and per-photo size, type, caps, model state
  upload every photo at once to Gemini's file store (one fails → delete the others: photo_upload_failed)
  insert row: platform 'photo', source_url 'photo:<random id>', state { photos, bestChosen: true } → Workflow → 202
Workflow: meta has nothing to fetch, video is skipped, extract waits for every file and makes one
  call (the images at resolution 'high', numbered "Picture 1:", ...), save as for a link, delete the files
```

- **Several photos are one recipe.** With more than one, the prompt says so and the answer
  may be `unrelated`, which fails with `photos_unrelated` (no Retry). With more than one,
  the answer also names the picture that best shows the dish (`cover`; anything out of range
  means the first), and the browser's copy of that photo becomes the recipe's picture
  ([Pictures](./07_pictures.md#photo-imports)).
- **Only written recipes.** A picture of food with no recipe text is `no_recipe`: the model
  never guesses a recipe from how a dish looks.
- **The originals live only in Gemini's free file store** and are deleted when the import
  ends: after the save, on `no_recipe` or `photos_unrelated`, when Google refuses them, and
  when the card is dismissed. A failed import that may be retried keeps them until Google
  deletes them (48 hours). Only their type is logged, never their uri.
  `createPhotoImport` in `imports.js` is the one place that handles the originals; the
  Workflow only knows "files Gemini can read".
- **The best model first, always** ([Models → Best model](./05_models.md#best-model)), and
  never the text-only fallback.
- **The same pictures twice** are allowed: each upload gets its own random id and recipe,
  for when the first read wasn't good enough. No hash, no `already_imported`.
- **Sizes**: the Worker reads the whole multipart body into memory, so the backend caps
  each photo and the total, and the frontend (`frontend/lib/photo.js`) shrinks only what
  would pass those caps. Gemini scales images down itself, so a phone photo or screenshot is
  sent as it is, to keep small print readable.
- **Why `X-Photo-Count`**: a plain HTML form on another site can send multipart, but no
  form can set a custom header without a CORS preflight, which fails. An older copy of the
  app may still send one picture as the whole body; that is still taken, as one photo.
- **No schema change**: `platform` is free text and `photo:<id>` satisfies both CHECKs on
  `source_url`. The API answers `link: ''` and `fromPhoto: true` for it. `readLink` never
  accepts `photo:` text, so a photo recipe can't be scanned again (`not_rerunnable`).
- **Retry** keeps `state.photos` and the best model; after Google's 48 hours it fails with
  `photo_expired`. A row from before multi-photo holds `state.photo`; the stages read it as
  one photo and a Retry turns it into `photos`.
- **Copyright block**: Google refuses (`recitation`) to write out text it recognises as a
  published recipe, and every model refuses the same way, so the import fails at once with
  `photo_copyrighted` instead of trying the others.

## Author

`recipes.author`, when it can be told. Optional; it never fails an import.

- **A video**: the channel or account that posted it, **from the site, never the model**
  (its answer schema has no `author` field). Each adapter reads it from the site's own data
  (YouTube's `channelTitle`, the post owner's name on Facebook and Instagram, with a
  fallback from the page title when the data is missing). A repost credits whoever posted it.
- **A web page**: the schema.org `Recipe` block's `author` when it gives a name. Otherwise,
  and for a page the model opens itself, the answer schema gets an optional `author` and the
  prompt asks for the person or brand the text names, **never a guess**.
- **Photos**: the model, the same way.
- Names are tidied (text-direction marks dropped, spaces collapsed); one over 100 chars is
  dropped. An import reuses the spelling of the same name already on another of the user's
  recipes (ignoring English case), so searching one source finds them all. What the user
  types is kept as typed.
- A re-scan replaces it with the one found and keeps the old one when none is found. The AI
  tools never touch it.

## Calories and protein

The extract prompt asks for them per serving: the post's own numbers if it gives them,
otherwise an estimate from the ingredients and servings. They are optional in the answer
schema, so a model that leaves them out still gives the recipe, and a value missing or out of
range is stored as `null` rather than failing the import. A re-scan replaces them. Any
recipe can also ask for them from the AI tools ([AI tools](./06_ai-tools.md#calories-and-protein)).

## Video

A video is sent if it's public and no longer than `IMPORT_MAX_VIDEO_MINUTES`; one of unknown
length is not sent. Gemini reads a YouTube video from its link. A Facebook or Instagram video
is a file, so the `video` stage **streams** it from the CDN into Gemini's file store (free,
deleted by Google after 48 hours) without holding it in memory, refusing one over
`IMPORT_MAX_VIDEO_MB`. `extract` waits until the file is processed. The file is deleted when
the import ends: by `save`, or by `extract` when the model found no recipe (a bad answer is
asked for again and still needs it). If the video is refused for good and there is enough
text, the import goes on with the text and records why (`state.videoSkipped`).

**Extract.** The description and subtitles count only above a minimum length; if neither text
nor video can be sent, it fails with no model call. One call returns the recipe in both
languages, the post's own language first. Everything from the site is sent as data, and
everything the model returns is untrusted and validated before it's stored.

## Retries and state

- A **Retry** inserts a new row (the failed one becomes `dismissed`) and starts a new
  Workflow from the first stage, keeping only the model choice (`state.bestChosen`) and a
  photo import's waiting pictures. It doesn't reuse what earlier stages left, because that
  expires: Meta's video links are signed for a limited time and Google deletes uploads after
  48 hours, and fetching them again costs no model request. The exception is a **failed
  save**, whose `state` already holds the recipe: it is copied, so no model is called again.
- Within one Workflow, finished stages are skipped through `state.done`, so a repeated step
  doesn't depend on how long Workflows keeps its history. `state.version` names the state's
  shape; a row holding an older shape starts again from its first stage.
- Every write is guarded by `status = 'running'` and the attempt, so a repeated step or a
  dismissal writes nothing and a recipe is never saved twice. (New rows always have
  `attempt` 1; older rows retried in place may have more.)
- Each stage may take 15 minutes and a Gemini request is cancelled after 14, so a retry
  never overlaps a call that is still running (video calls have taken over 5 minutes).
- A busy model doesn't use the Workflow's quick retries: [Models → Busy models](./05_models.md#busy-models).

## Failures

`error` is written to the row before a stage throws, with the reason in words in
`error_detail` (never sent to the browser).

| Case | Code | Automatic retry | User can Retry |
|---|---|---|---|
| Removed or private, or the video couldn't be used and nothing else had the recipe; a web page that answered 404/410 | `video_unavailable` | no | no |
| The site redirected to a login page, or shows the post only after a login; a web page's 401 | `login_required` | no (Instagram: [the busy waits](./05_models.md#busy-models)) | yes |
| The site answered 5xx (or 403/429 for Facebook and Instagram), couldn't be reached, or sent a page with none of the known parts | `source_blocked` | yes, 3 tries | yes |
| A web page's other 4xx; one that turned the Worker away (403/429) and Google couldn't open either | `source_blocked` | no | yes |
| A share link led to a recipe the user already has | `already_imported` | no | no |
| A share link led to something that isn't a video or post; a web page redirected to a refused address, or isn't a page (a PDF, an image, too big) | `link_unsupported` | no | no |
| Private or unlisted, description not enough | `video_private` | no | no |
| Too long, description not enough | `video_too_long` | no | no |
| No recipe | `no_recipe` | no | no |
| Several recipes | `multiple_recipes` | no | no |
| Every model it could use is busy (503) or was cut off by Cloudflare (524) | `llm_error` | yes, [backed off](./05_models.md#busy-models) | yes |
| Other 5xx, network, timeout | `llm_error` | yes, 3 tries per stage | yes |
| Invalid output | `bad_result` | yes, 3 tries per stage | yes |
| Every model it could use is out for the day | `quota` | no | yes |
| No model it could use can run (all retired or key refused) | `llm_error` | no | yes |
| Stuck for 30 minutes | `timed_out` | no | yes |
| Photo: Google refused the picture, or couldn't process it | `photo_unreadable` | no | no |
| Photo: Google won't write out a published recipe (`recitation`) | `photo_copyrighted` | no | no |
| Photo: an uploaded file is gone (a Retry after Google's 48 hours) | `photo_expired` | no | no |
| Photos: not all parts of one recipe | `photos_unrelated` | no | no |

Photos refused before any row exists answer the POST and never show as cards:
`photo_invalid` (not one of the five image types, empty, or not the app's request),
`photo_too_many`, `photo_too_big`, `photo_upload_failed` (Google's file store wouldn't take one).

## Known gaps and accepted trade-offs

Accepted:

- PR previews can't run imports ([Deploy](../operations/01_deploy.md#pr-previews)).
- Web pages are read as plain text, as an anonymous visitor: a page built only in JavaScript
  fails with `no_recipe`, and one that blocks both the Worker and Google fails with
  `source_blocked`. "Scan the link again" reads the page again.
- Facebook and Instagram are read as an anonymous visitor, so only public posts work, and Meta
  may block or change this at any time. From Cloudflare's network a Facebook share link may be
  sent to the login page; that works only when the login page names the video. Facebook photo
  and text posts aren't supported. An Instagram post that really needs a login (an age
  limit) fails only after about 11 minutes of waits, since its login wall looks like the
  one that comes and goes.
- A photo import's Retry works only for 48 hours; then it fails with `photo_expired` and the
  user chooses the photos again.
- Google refuses to write out a recipe it recognises as published (a famous chef's page), so
  such a photo fails with `photo_copyrighted`; the user adds it manually.

Small gaps, all rare and harmless:

- "Scan the link again" still shows while that scan is running; tapping it answers
  `not_rerunnable`.
- A Retry that can no longer work says so and leaves the card for the user to dismiss.
- Home can miss one recipe-list reload if an import finishes in the instant between its first
  two requests. Opening the ready card still works.
- A running import dismissed through the raw API (the UI has no × on running cards) may still
  finish its model call, but saves nothing.
- An uploaded video stays in Gemini's file store until Google deletes it (48 hours) when its
  import fails before a usable answer. A Retry uploads it again.
- A retryable failed photo import keeps its photos in Gemini's file store until the card is
  dismissed or Google deletes them, and every failed photo import keeps the browser's copies
  in `import_pictures` until its card is dismissed.
- A photo import's "Pick a link with one recipe" (`multiple_recipes`) still says "link".
