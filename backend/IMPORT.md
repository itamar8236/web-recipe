# Import from a link or a photo

How a link or a photo becomes a recipe: one Cloudflare Workflow in `src/import/`. The
endpoints are in [`README.md`](README.md#import-api) → Import API. Read the root
`AGENTS.md` first, and this file's
[Known gaps and accepted trade-offs](#known-gaps-and-accepted-trade-offs) before changing
an import.


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
           (+ the chosen one of a photo import's waiting pictures becomes the recipe's)
  picture  After the import is done: the link's picture, fetched, resized and saved
           (never fails the import; see Pictures)
```

**Calories and protein.** The extract prompt asks for them per serving, as whole numbers:
the post's own numbers if it gives them, otherwise the model's estimate from the
ingredients and the number of servings. They are optional in the answer schema, so a model
that leaves them out still gives the recipe. A value that is missing, or outside 0-10000
kcal / 0-1000 g, is stored as `null` rather than failing the import; decimals are rounded.
A re-scan replaces them along with the text. Any recipe, manual ones too, can also ask the
model for them from the AI tools ([Calories estimate](README.md#calories-estimate)).

## Author

An import also saves who the recipe is by (`recipes.author`), when it can be told. It is
optional and never fails an import:

- **A video** (YouTube, Facebook, Instagram): the channel or account that posted it, from
  the site itself, never from the model, which isn't asked (its answer schema has no
  `author` field). YouTube: the API's `snippet.channelTitle`. Facebook: the `owner.name`
  of the video's own node in the page data; a page without its data (the preview-text
  fallback) still has it as the last `" | "` part of its `<title>`. Instagram: the
  account's `full_name` without the tagline some put after a `" | "`, or its `username`
  when it shows no name; a preview-only page gives the name before `" on Instagram"` in
  `og:title`. A repost credits whoever posted it.
- **A web page**: the schema.org `Recipe` block's `author` (a name, a Person or an
  Organization, the first of a list) when it gives a name. Otherwise, and for a page the
  model opens itself, the answer schema gets an optional `author` field and the prompt
  asks for the person or brand the text names as the recipe's author, never a guess.
- **A photo**: always the model, the same way.
- A name is tidied (invisible text-direction marks dropped, spaces collapsed), and one
  over 100 characters is dropped. Before saving, an import reuses the spelling of the same
  name (ignoring the case of English letters) on another of the user's recipes, so
  searching for one source finds them all. What the user types in the edit form is kept as
  typed.
- "Scan the link again" replaces it with the one found, and keeps the recipe's own when
  none is found. A copy from Browse brings it along. Translating and the calories estimate
  never touch it.

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
leads to something that isn't a video or post fails with `link_unsupported`. From some
networks (seen from Cloudflare's), Facebook sends a share link of a public video to its
login page instead; when that page's `next` parameter is the video's link, the import reads
the video from its own page (`/watch/?v=<id>`, built from the parsed id) and goes on.
Otherwise it fails with `login_required`, and `error_detail` keeps the login page's full
address, query included, to show what Facebook sent.

## Web pages

Any public page with a recipe, such as a recipe site or a blog post (`sources/web.js`).
There is no id to rebuild a link from, so the pasted link is fetched, and that is guarded:

- `isFetchableUrl` checks the link and **every redirect hop**, followed by hand (at most 5,
  onto any public host, since a site often moves to its `www.` host): http or https, the
  default port, no `user:pass@`, and a real domain name, never an IP address (the URL parser
  turns every numeric form into one), `localhost` or a private-network name (`.local`,
  `.internal`, ...). Cloudflare's own fetch can't reach private addresses either.
- One request with a browser's headers, a 30-second timeout, at most 5 MB, and only
  `text/html`, `application/xhtml+xml` or `text/plain`; anything else is
  `link_unsupported`. No video is sent. The only thing the page links to that is fetched
  is its one preview image (`og:image`), with the same checks ([Pictures](README.md#pictures)).
- No proxies, scraping services, logins or CAPTCHA solvers, here or for any site.
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
- **A page that turns the Worker away (403 or 429)** is opened by the model itself, with
  Google's URL context tool (`url_context`): many sites' bot protection blocks Cloudflare's
  addresses but not Google's. The Worker stops there, reads nothing of the page, and sends
  the model only its address (the last redirect hop, which passed `isFetchableUrl`); the
  card's title is the host name. The request goes through the usual model order, but
  never to the fallback model, which has no such tool. Unless Google reports that it
  opened the page, the answer is not used and the import ends as `source_blocked`, with no
  retry and no other model, since any of them would open it the same way. A `share.google` link can't be opened
  this way, so the Worker's own redirects lead the model to the real page.
- Failures: 404 or 410 is `video_unavailable`; 401, or a redirect to a login path, is
  `login_required`; 5xx and a site that can't be reached (also a domain that doesn't
  exist) are `source_blocked`, retried by the Workflow; any other 4xx is `source_blocked`
  with no retry.
- A site that builds its page only in JavaScript, or blocks Google too, can't be read
  (`no_recipe` or `source_blocked`). "Scan the link again" reads the page again.

## Facebook and Instagram

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
  `source_blocked` with the reason in `error_detail` and in the logs. From there Instagram
  shows a public post's login wall only some of the time (seen 2026-11-24: one reel failed
  several Retries, then imported), so an Instagram login wall (a redirect to its login
  page, the login page itself, or a post shown only after a login) is tried again after the
  busy waits ([Video, models and failures](#video-models-and-failures)), 4 tries over about 11 minutes. A post that really
  needs a login fails only after those waits. Meta can also change
  its pages at any time; `scripts/e2e-links.mjs` is the check.

## Import from a photo

A logged-in user sends **1 to 7 pictures of one written recipe** (cookbook pages, screenshots,
a handwritten card, and maybe a photo of the dish). They go through the same Workflow as a
link, are read together in **one** model request, and the recipe is saved the same way,
with no tags. They come from "Choose photos" in the Add recipe dialog or from the phone's
gallery through the Share menu (`frontend/README.md` → Screens → Share); the backend can't
tell the two apart.

```
POST /api/imports/photo   multipart: `photo` parts in order, header X-Photo-Count = their number
  guards: session, X-Photo-Count matches the parts (photo_invalid), 1-7 (photo_too_many),
          body up to 50 MB (photo_too_big), each part: type (photo_invalid),
          size 1 byte - 20 MB (photo_invalid, photo_too_big), caps,
          model state (with the best model chosen)
  upload every photo, at the same time, to Gemini's file store → [{ name, uri, mimeType }]
    (if one fails, the others are deleted: photo_upload_failed)
  insert llm_requests row: platform 'photo', source_id <random 32-hex id>,
    source_url 'photo:<id>', state { photos: [files], bestChosen: true }   → start Workflow → 202
Workflow: meta has nothing to fetch, video is skipped, extract waits for every file and makes
  one call (photo prompt + the images at resolution 'high', numbered "Picture 1:", ...),
  save as for a link, then deletes the files
```

- **Several photos are one recipe.** With more than one, the prompt says they should be
  parts of one recipe (its pages, or the recipe and the dish), and the answer's `status`
  has one more value, `unrelated`: a photo of another recipe, or of something else, fails
  the import with `photos_unrelated` (no Retry). One photo gets the same prompt as before.
- **Which photo is the picture.** With more than one, the answer also has `cover`, the
  number of the picture that best shows the finished dish (1 when none does). It is stored
  from 0 (`recipe.cover` in the state, then `{ cover }` on the finished row), and anything
  that isn't a whole number in range means the first photo. One photo is never asked.
  The browser's resized copy of that photo becomes the recipe's picture
  ([Pictures](README.md#pictures)).
- **A resized copy of one photo is kept as the recipe's picture. The originals wait only
  in Gemini's free file store and are deleted when the import ends**: after the save, when
  the model found no recipe or said the photos are unrelated, when Google refused them, and
  when the card is dismissed. A failed import that may be retried keeps them until Google
  deletes them (48 hours). Only their type is logged, never their uri. The copies are made
  by the browser and sent right after the 202 (`PUT /api/imports/:id/picture`, see
  [Pictures](README.md#pictures)).
- **The best model first, always.** Every photo import is like `model: 'best'`: it takes
  one of the user's 5 when it calls the best model, and when the best model can't be used
  (shared count or the user's 5 used, busy, over its quota, or can't run) it goes on with
  the import models by itself. A photo never reaches the text-only fallback model.
- **Only written recipes.** The prompt says a picture of food with no written recipe is
  `none` (`no_recipe`): the model never guesses a recipe from how a dish looks.
- **The same pictures twice** are allowed: each upload gets its own random id and makes its
  own recipe, for when the first read wasn't good enough. No hash, no `already_imported`.
- **Size rule.** Each photo may be up to 20 MB, and all of them together up to 50 MB (the
  Worker reads the whole multipart body into its 128 MB). The frontend sends every picture
  up to 15 MB unchanged and shrinks a bigger one, and if they are still over 48 MB together
  it shrinks every one over about 7 MB too (`frontend/lib/photo.js`). Gemini scales every
  image down itself (about 1,100 image tokens at `high` for each picture), so a phone
  photo or screenshot is sent as it is, to keep small print readable.
- **Why the header**: another site's plain HTML form can send multipart, but no form can
  set `X-Photo-Count` without a CORS preflight, which fails. An older copy of the app may
  still send one picture as the whole body, with its type as the Content-Type; that is
  still taken, as one photo.
- **The API**: a photo recipe's `source_url` is `photo:<id>` (no schema change: `platform`
  is free text, and the `photo:` value satisfies both CHECKs). Recipes, Browse and the
  import cards answer `link: ''` and `fromPhoto: true` for it, and a copy from Browse keeps
  both. `readLink` never accepts `photo:` text, so a photo recipe can't be scanned again
  (`not_rerunnable`).
- **Retry** keeps `state.photos` and the best model (the pictures themselves are no longer
  here). After Google's 48 hours the files are gone and it fails with `photo_expired`. A row
  started before several photos holds one, as `state.photo`; the stages read it as one
  photo, and a Retry turns it into `photos`.
- **Google's copyright block.** Google refuses (400, `recitation`) to write out text it
  recognises as published and copyrighted. A photo of a famous chef's recipe page is
  refused by every model the same way, so a photo import fails at once with `photo_copyrighted` rather than trying the other models.
- `createPhotoImport` in `imports.js` is the one place that handles the uploaded originals,
  and the Workflow only knows "files Gemini can read".

**Several photos (tested 2026-11-23).** The owner's 4 Instagram-story screenshots of one
Hebrew recipe (ingredients, steps part 1, steps part 2, and the dish with a few lines of
text, 945×2048, 88-198 KB each), sent with the dish last: the best model was over its quota,
`gemini-3.8-flash` was busy, and `gemini-3.6-flash` read all four in one request (122 s,
4,312 image tokens) into a complete, correct recipe, with the author, and chose picture 4,
the dish. The same three text screenshots with a made-up picture of a pancake recipe failed
with `photos_unrelated`, as they should.

## Video, models and failures

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
  with the import models by itself, and nobody is told or asked. Over its quota, a
  background request isn't refused with a 429: it fails at once (`status: failed`, with
  `errors: [{ code: 'RESOURCE_EXHAUSTED' }]`), which is read as a short quota limit, like a
  busy model, so the import goes on with the import models (seen 2026-11-23). Photos share its 20 a day
  with re-scans, so on a busy day most photo imports use the import models. It runs in
  Google's **background mode** (`background: true`): Google answers at once with an id and
  keeps working, and the stage asks for the answer by that id (`GET /v1beta/interactions/<id>`),
  after 5 s, then 10, 15... up to every 30 s, at most 14 minutes, so about 30 requests,
  under the free plan's 50 per step. No request stays open long enough for Cloudflare's
  ~100 s cut (524, below). Only the best model uses it: Google lists background mode for
  `gemini-4-hydrogen` and `gemini-3.8-flash`, not for the other import models. Its log line
  says `(background)`, so its times can be compared with the others'.
- **Cloudflare's ~100 s cut (524).** A request to Google that sends nothing back for about
  100 s is ended by Cloudflare, which Gemini's error shows as `524` (`error code: 524`).
  The stronger models can take minutes on a short video, while the small one takes
  seconds with a recipe as complete. So a 524 is treated like a busy model: the next model is
  tried at once, instead of retrying the slow one, but its request stays counted, since
  Google ran it.
- **The fallback model** can't watch a video, read a photo or open a web page, so a request with one never reaches it. It
  is off until `GROQ_API_KEY` is set. Groq's free limit when checked was 1,000 requests and
  200,000 tokens a day, 8,000 tokens a minute; the app's own cap (`LLM_DAILY_LIMITS`) is
  lower, at 200.
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
- The daily limits are what AI Studio showed the owner.

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
So every link the admin imports (`POST /api/imports`) asks for it too, as if `model: 'best'`.

**Quota.** Daily quotas reset at **midnight Pacific** (`nextQuotaReset`). Google offers no
way to ask how many requests are left, so `llm_usage` counts them: every real call first
reserves one, in one atomic statement, up to the model's limit in `LLM_DAILY_LIMITS`. A
failed call still counts, because Google may have counted it, except a 503, a short rate
limit, or a model that can't run: Google says a 503 is "unrelated to your quota", and a
rejected request is never served, so its request is given back to this shared count (not to the user's 5, see above). Google counts a 503 anyway: on 2026-11-23
`gemini-3.8-flash` was sent 26 requests that weren't refused with a 429, all 503s, and AI
Studio counted 26 against its 20 a day. Google's per-day 429 below sets the count right. A
429 naming a per-day quota, in its details or only in its message ("20 requests per day"),
sets the model's count to the limit, which alone keeps it unused until the reset. Any other 429
(a per-minute limit) is treated like a busy model; nothing is remembered, so the next
request simply tries. In every case the request moves to the next model at once.

**Failures.** `error` is written to the row before a stage throws, with the reason in words
in `error_detail` (never sent to the browser).

| Case | Code | Automatic retry | User can Retry |
|---|---|---|---|
| Removed or private, or the video couldn't be used and nothing else had the recipe; a web page that answered 404/410 | `video_unavailable` | no | no |
| The site redirected to a login page, or shows the post only after a login | `login_required` | no (Instagram: the busy waits below) | yes |
| The site answered 5xx (or 403/429 for Facebook and Instagram), or sent a page with none of the known parts | `source_blocked` | yes, 3 tries | yes |
| A web page turned away the Worker (403/429) and Google couldn't open it either | `source_blocked` | no | yes |
| A share link led to a recipe the user already has | `already_imported` | no | no |
| A share link led to something that isn't a video or post; a web page redirected to a refused address, or isn't a page (a PDF, an image, over 5 MB) | `link_unsupported` | no | no |
| Private or unlisted, description not enough | `video_private` | no | no |
| Too long, description not enough | `video_too_long` | no | no |
| No recipe | `no_recipe` | no | no |
| Several recipes | `multiple_recipes` | no | no |
| Every model it could use is busy (503) or was cut off by Cloudflare (524) | `llm_error` | yes, see below | yes |
| Other 5xx, network, timeout | `llm_error` | yes, 3 tries per stage | yes |
| Invalid output | `bad_result` | yes, 3 tries per stage | yes |
| Every model it could use is out for the day (some may also have been unable to run) | `quota` | no | yes |
| No model it could use can run (all retired or key refused) | `llm_error` | no | yes |
| Stuck for 30 minutes | `timed_out` | no | yes |
| Photo: Google refused the picture, or couldn't process it | `photo_unreadable` | no | no |
| Photo: Google won't write out a published recipe (`recitation`) | `photo_copyrighted` | no | no |
| Photo: an uploaded file is gone (a Retry after Google's 48 hours) | `photo_expired` | no | no |
| Photos: not all parts of one recipe | `photos_unrelated` | no | no |

Photos are refused before any row exists, so these answer the POST and never show as cards:
`photo_invalid` (not one of the five image types, empty, or not the app's request),
`photo_too_many` (more than 7), `photo_too_big` (one over 20 MB, or all over 50 MB),
`photo_upload_failed` (Google's file store wouldn't take one).

Each stage may take 15 minutes; a Gemini request is cancelled after 14, so a retry never
overlaps a call that is still running (video calls have taken over 5 minutes).

A busy model (503, "high demand") costs no time: the stage moves on to the next model in
the same run, but Google still counts the request (see Quota). Only when **every** model it could use was busy does the stage end as busy.
That can last minutes or hours, so it skips the quick retries and follows Google's advice
instead: back off and retry, short at first and longer after. The stage ends without
failing, and the Workflow sleeps (`step.sleep`) **30 seconds, then 2 minutes, then 8
minutes** before each new run, so 4 runs in all, each starting again from the first model
(and from the best model, when the user asked for it); still busy after that, it fails with
`llm_error`. The card shows the import as still running meanwhile. Instagram's login wall
gets the same waits ([Facebook and Instagram](#facebook-and-instagram)), and fails with
`login_required` after the last one. Every busy answer's
request is given back to the shared count, though Google counts it.

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
"Photo upload failed: GEMINI_API_KEY is not set"). Giving previews the key would let
any preview spend the production quota. Test photo imports locally.

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

## Known gaps and accepted trade-offs

Never fix one without asking the owner. Accepted:

- PR previews can't exercise the import Workflow: they use the one already deployed to
  production (see Limits to keep in mind above). A photo import fails on a preview at once
  (`photo_upload_failed`): previews have no Gemini key, so test photos locally.
- The free-tier model quota is shared by all users: 20 requests a day on each stronger
  model, 500 on the small one.

Known bug, not fixed yet:

- Google counts a busy model's 503 against its 20 a day, but the app gives the request back
  and tries the model again on every busy wait. On a day of high demand the stronger models
  use up their 20 on 503s alone (2026-11-23: 26 requests to `gemini-3.8-flash`, none
  answered), so imports end on `gemini-3.5-flash-lite`.
- Web pages are read as plain text, as an anonymous visitor: a site that builds its page
  only in JavaScript fails with `no_recipe`, and one that blocks the Worker (403/429) is
  opened by Google instead, failing with `source_blocked` only when Google is blocked too
  ([Web pages](#web-pages)).
- Facebook and Instagram are read as an anonymous visitor, so only public posts work, and
  Meta may block or change this at any time ([Facebook and Instagram](#facebook-and-instagram)).
  From Cloudflare's network a Facebook share link may be sent to the login page; that works
  only when the login page names the video. Facebook photo and text posts aren't supported.
  An Instagram post that really needs a login (an age limit) fails only after about 11
  minutes of waits, since its login wall looks like the one that comes and goes.
- A photo import's Retry works only for 48 hours, while Google keeps the uploaded pictures;
  then it fails with `photo_expired` and the user chooses the photos again.
- Photos share the best model's 20 a day with re-scans, so on a busy day most photo imports
  use the usual models.
- Google refuses to write out a recipe it recognises as published and copyrighted (a famous
  chef's page), so such a photo fails with `photo_copyrighted`; the user adds it manually.

Small gaps, all rare and harmless:

- "Scan the link again" still shows while that scan is running; tapping it answers
  `not_rerunnable`.
- A Retry that can no longer work says so and leaves the card for the user to dismiss.
- Home can miss one recipe-list reload if an import finishes in the instant between its first
  two requests. Opening the ready card still works.
- A running import dismissed through the raw API (the UI has no × on running cards) may still
  finish its LLM call, but saves nothing.
- An uploaded video stays in Gemini's file store until Google deletes it (48 hours) when
  its import fails before a usable answer. A Retry uploads the video again.
- A photo import that failed in a way Retry can help with keeps its pictures in Gemini's file
  store until the card is dismissed or Google deletes them (48 hours); after that a Retry
  fails with `photo_expired`, and the user chooses the photos again. Every failed photo
  import keeps the browser's resized copies (about 165 KB each) in `import_pictures` until
  its card is dismissed.
- A photo import's "Pick a link with one recipe" (`multiple_recipes`) still says "link".
- When every import model is out for the day a new import is refused with `quota` before
  it starts, even if the fallback model could have read its text.
- A scan that asked for the best model doesn't say when another model answered instead;
  the recipe's `source_model` shows it.
