# Models and quota

Users choose no model. `src/import/models.js` tries a fixed list and moves on **at once** from
a model that is busy, rate-limited, out for the day, or can't run. Imports and the
[AI tools](./06_ai-tools.md) share this code and the daily counts. Every model, its order and
its daily limit is config, in `vars` of [`backend/wrangler.jsonc`](../../backend/wrangler.jsonc)
(with a comment on each), so changing them needs no code change:

| Setting | Used for |
|---|---|
| `LLM_IMPORT_MODELS` | Imports, Retries and re-scans, in this order |
| `LLM_TRANSLATE_MODELS` | The AI tools: short text work for the small model, which leaves the stronger models' few daily requests for videos and photos |
| `LLM_FALLBACK_MODEL` (Groq) | After either list, only for a request with **no video, photo or page to open**; off until `GROQ_API_KEY` is set |
| `LLM_BEST_MODEL` | When the user asks for it, and first for every photo import |
| `LLM_DAILY_LIMITS` | Every model's requests a day: what AI Studio and Groq showed the owner. A model missing from it is never called |
| `LLM_BUSY_RETRY_MS` | The AI tools only: the waits before trying every model again when all were busy |
| `IMPORT_BEST_DAILY_PER_USER` | Best-model tries per user per day |

The quota is per Google project and shared by all users, and Google says its limits aren't
guaranteed.

## Best model

The one choice a user has: "Use the best model" in the confirmation of "Scan the link again"
(`model: 'best'`), and every photo import uses it with no checkbox. It is slower and more
detailed. It is tried first, once; if it is busy, out for the day, or the user has used their
daily tries, the import goes on with the import models by itself, and **nobody is told or
asked**. Every link the admin imports asks for it too.

- **Per-user tries** (`IMPORT_BEST_DAILY_PER_USER`): a row takes one (`used_best = 1`, in one
  statement, so two rows can't take the last one) when it is about to call the best model,
  and keeps it once a request reached Google, even if the model was busy or another model
  wrote the recipe: trying is what is counted. A row may call the model several times
  (Workflow retries, busy waits, a second ask without the video) but takes one try. It is
  given back only when nothing was sent. `state.bestChosen` keeps the choice through retries
  and a Retry.
- **The admin** (`users.is_admin = 1`, not while acting as another user) has no per-user
  limit: their rows are still marked `used_best`, but only the shared count stops them.
- **Over its quota in background mode**, Google doesn't answer 429: the request fails at once
  with `RESOURCE_EXHAUSTED` in its errors, which is read as a short rate limit, so the import
  goes on with the other models.
- **Background mode**: the best model runs with `background: true`. Google answers at once
  with an id and the stage polls for the answer with growing waits, staying under the free
  plan's subrequests per Workflow step, so no request stays open long enough for
  Cloudflare's cut-off (below). Only the best model uses it (Google lists background mode
  only for some models). Its log line says `(background)`, so its times can be compared.

## Quota

Daily quotas reset at **midnight Pacific** (`nextQuotaReset`). Google can't be asked how
many requests are left, so `llm_usage` counts them: every real call first reserves one, in
one atomic statement, up to the model's limit.

- A failed call still counts, because Google may have counted it, **except** a 429 or a
  model that can't run: a rejected request is never served, so it is given back to the
  shared count (never to the user's best-model tries).
- A busy model's request (503, 524) **stays counted**. Google says a 503 is "unrelated to
  your quota", but it counts it: on 2026-11-23 `gemini-3.8-flash` was sent 26 requests that
  weren't refused with a 429, all 503s, and AI Studio counted 26 against its 20 a day.
- A 429 naming a per-day quota, in its details or only in its message ("20 requests per
  day"), sets the model's count to the limit, which keeps it unused until the reset; Google
  may have counted requests the app didn't make. Any other 429 (per minute) is treated like
  a busy model; nothing is remembered.

## Busy models

A busy model (503, "high demand") costs no time: the request moves on to the next model in
the same run. It does cost one of the model's daily requests ([Quota](#quota)). Only when **every** model it could use was busy is the request busy.

- **Imports**: busy can last minutes or hours, so the stage skips the Workflow's quick
  retries and follows Google's advice to back off: it ends without failing and the Workflow
  sleeps (`step.sleep`) 30 seconds, then 2 minutes, then 8 minutes, each run starting again
  from the first model (or the best one, when chosen). Still busy after that: `llm_error`.
  The card shows the import as running meanwhile. Instagram's login wall gets the same
  waits ([Import → Facebook and Instagram](./04_import.md#facebook-and-instagram)).
- **AI tools**: the user is waiting, so the whole list, fallback included, is tried again
  after each wait in `LLM_BUSY_RETRY_MS`; still busy is `model_busy`.
- No wait has jitter: there are too few users for retries to pile up, and a Workflow must
  sleep the same on every replay. Google's Batch API is not used: its results can take hours.

**Cloudflare's ~100 s cut-off (524).** A request to Google that sends nothing back for about
100 s is ended by Cloudflare, which Gemini's error shows as `524`. The stronger models can
take minutes on a short video while the small one answers in seconds, so a 524 is treated
like a busy model: the next model is tried at once. Its request stays counted, since Google
ran it.

## Models that can't run

`ModelUnusableError`: the provider rejected the request with a 4xx other than 429 that is
about the model or the key (a retired or renamed model, a refused key). It is logged, its
request is given back to the shared count, and the next model is tried; a best model that
can't run still uses up the user's try. A request with no video is only our prompt, so any
such 4xx counts. With a video, a 4xx counts only when Google's message names the model, the
key or a disabled API, or it is a 401; any other is the video being refused
(`VideoRefusedError`), and the stage asks again without it.

Which model answered is stored on the recipe (`source_model`) and the request
(`llm_requests.model`).

## Logging

`llm.js` logs each Gemini request (the model, the video link or only a photo's type, and the
**full prompt**), each answer (time and the tokens Google counted), each upload and each
failure (status and Google's error text), never the key. Prompts are logged in full, the AI
tools' too, which hold the user's own recipe: the owner's choice, for debugging. `groq.js`
logs the same way. Where to read the logs: [Deploy → Logs](../operations/01_deploy.md#logs).

## Known gaps and accepted trade-offs

- The free-tier quota is small and shared by all users.
- A busy model is tried again by every new import and after every busy wait, and each 503
  uses one of its daily requests. On a day of high demand the stronger models can use up
  their 20 on 503s alone, so imports end on the small model. The owner chose this over
  resting a busy model for a while.
- Photo imports share the best model's daily requests with re-scans, so on a busy day most
  photo imports use the usual models.
- When every import model is out for the day, a new import is refused with `quota` before
  it starts, even if the fallback model could have read its text.
- A scan that asked for the best model doesn't say when another model answered instead;
  the recipe's `source_model` shows it.
