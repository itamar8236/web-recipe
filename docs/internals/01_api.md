# HTTP API

The contract between `frontend/lib/api.js` and the Worker. The two apps share no code or
types, so this page is the only written definition of the wire: change it in the same PR
as a route, a shape or an error code. Behavior behind the endpoints lives in the topic
pages linked from each section.

## Rules for every endpoint

- JSON in and out. Errors are `{ "error": "<code>" }`; `errorMessage()` in
  `frontend/lib/i18n.js` turns a code into text.
- Every endpoint needs a session (401 `not_logged_in`) except register, login and logout.
  Unknown paths are 404 when logged in; a known path with the wrong method is 405
  `method_not_allowed`.
- Everything acts for the session's user, or the user the admin logs in as
  ([Login](./03_auth.md#admin-login-as-a-user)). Another user's tag, recipe or import
  answers 404, exactly like one that doesn't exist.
- A body must be JSON with `Content-Type: application/json` (400 `invalid_request`
  otherwise), except the multipart uploads below. That header, and `PUT` for picture
  uploads, keep another site's plain HTML form from sending these requests: a form can
  send only form types, and multipart only by `POST`.

## Auth

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/auth/register` `{username, password}` | Create a user (never admin) and log in | 201 `{user}` | 400 `username_invalid` (1-50 chars after trimming), 400 `password_invalid` (1-200 chars), 400 `invalid_request`, 409 `username_taken` (case-insensitive), 403 `user_limit` (50 users) |
| `POST /api/auth/login` `{username, password}` | Log in on this device | 200 `{user}` | 400 `invalid_request`, 401 `invalid_credentials` (same for wrong password and unknown user) |
| `POST /api/auth/logout` | Delete this device's session | 200 `{ok}` | none (works without a session) |
| `GET /api/auth/me` | Who is logged in | 200 `{user}` | 401 `not_logged_in` |
| `PUT /api/auth/me` `{username?, password?, defaultPublic?, copyTags?}` | Change your own username, password and/or defaults (at least one; the old password is not asked for). Every existing login stays | 200 `{user}` | 400 `invalid_request` (also a default that isn't `true`/`false`), `username_invalid`, `password_invalid` (same limits as sign-up), 409 `username_taken`, 401 `not_logged_in` |
| `GET /api/admin/users` | Admin only: everyone else, to log in as | 200 `{users: [{id, username}]}`, A to Z | 403 `not_admin`, 401 `not_logged_in` |
| `POST /api/admin/impersonate` `{userId}` | Admin only: log this device in as that user, no password | 200 `{user}` (that user) | 400 `invalid_request`, 404 `not_found` (no such user, or the admin), 403 `not_admin`, 401 `not_logged_in` |

`user` is `{ id, username, is_admin, defaultPublic, copyTags }`. The last two are the
user's defaults, both `true` for a new user: a recipe they add (manually, by import or by
copying) starts public, and copying a recipe in Browse copies its tags too.

## Tags and recipes

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/tags` | The user's tags, oldest first | 200 `{tags: [{id, name}]}` | |
| `PUT /api/tags/:id` `{name}` | Rename a tag | 200 `{tag}` | 400 `name_required`, `too_long` (> 100 chars), 409 `tag_exists` (another tag has that name), 404 `not_found` |
| `GET /api/recipes` | All the user's recipes, oldest first | 200 `{recipes: [recipe]}` | |
| `GET /api/recipes/:id` | One recipe | 200 `{recipe}` | 404 |
| `POST /api/recipes` `{en, he, calories?, protein?, author?}` | Create a manual recipe, with no tags | 201 `{recipe}` | 400 `name_required` (no name in either language), `too_long`, `invalid_nutrition`, `invalid_request` |
| `PUT /api/recipes/:id` `{en, he, calories?, protein?, author?}` | Replace its text, and the calories, protein and author sent (one left out is kept; `null` clears it, and so does `''` for the author). Tags, favorite and link are kept | 200 `{recipe}` | 400 as above, 404 |
| `PUT /api/recipes/:id/tags` `{tags: [name]}` | Set its tags to exactly these names | 200 `{recipe, tags}` | 400 `invalid_request`, `name_required` (a blank name), `too_long` (a name > 100 chars, or > 20 tags), 404 |
| `PUT /api/recipes/:id/favorite` `{favorite: true\|false}` | Set (not toggle) the favorite | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `PUT /api/recipes/:id/public` `{public: true\|false}` | Set (not toggle) whether other users can see and copy it | 200 `{recipe}` | 400 `invalid_request`, 404 |
| `DELETE /api/recipes/:id` | Move it, with its picture, to Recently deleted | 200 `{ok}` | 404 |
| `GET /api/deleted-recipes` | The user's deleted recipes from the last 30 days, most recently deleted first | 200 `{recipes: [{id, en: {name}, he: {name}, deletedAt, expiresAt}]}` | |
| `POST /api/deleted-recipes/:id/restore` | Put it back among the user's recipes, with its tags | 200 `{recipe, tags}` | 404 (not theirs, already restored, or over 30 days old) |
| `GET /api/recipes/:id/picture[?size=thumb]` | The recipe's picture (or its thumb): yours, or anyone's public one (Browse) | 200 the bytes, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` | 404 (no picture, or another user's private recipe) |
| `PUT /api/recipes/:id/picture`, multipart `full` + `thumb` | Set the picture the user chose, replacing any | 200 `{picture}` | 400 `picture_invalid`; 413 `picture_too_big`; 404 |
| `DELETE /api/recipes/:id/picture` | Remove its picture | 200 `{ok}` | 404 |

`recipe` is `{ id, tagIds, favorite, public, link, fromPhoto, sourceModel, calories, protein, author, picture, en, he }`:

| Field | Meaning |
|---|---|
| `en`, `he` | `{ name, ingredients: [string], steps: [string] }`. The backend trims names and lines and drops blank lines. Limits (`too_long`): name 200 chars, 200 ingredients or steps per language, 2000 chars per line |
| `tagIds` | Its tags' ids, lowest first (`[]` for none) |
| `public` | Other users can see and copy it in Browse; a new recipe gets the user's `defaultPublic` |
| `link` | The source link (a video, a post or a web page); `''` for a manual recipe and for one read from a photo |
| `fromPhoto` | `true` when read from photos ([Import](./04_import.md#import-from-photos)) |
| `sourceModel` | The model that produced it; `null` for a manual recipe |
| `calories`, `protein` | kcal and grams per serving, whole numbers, `null` when not known; the same in both languages. `invalid_nutrition`: not a whole number from 0 to 10000 (calories) or 1000 (protein) |
| `author` | Who it is by, `''` when not known; the same in both languages, at most 100 chars (`too_long`), kept as typed with spaces tidied ([Author](./04_import.md#author)) |
| `picture` | `null`, or `{ url, thumb }`: `/api/recipes/<id>/picture?v=<updated_at>` and the same with `&size=thumb`. The address changes with every new picture, so the browser caches it for good |

A picture upload is two parts the browser made from one picture, both JPEG or both WebP
(checked by their first bytes, not the type they claim), `full` at most 1,000,000 bytes
and `thumb` at most 100,000; anything else is `picture_invalid` / `picture_too_big`
([Pictures](./07_pictures.md)).

## Browse

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/browse?seed=<n>[&after=<next>]` or `?sort=<order>[&after=<next>]` | One page (10) of other users' public recipes | 200 `{recipes, next}` | 400 `invalid_request` (an unknown `sort`, `seed` not a whole number from 1 to 1000002, or a bad `after`) |
| `POST /api/browse/:id/copy` `{}` | Save your own copy of that recipe | 201 `{recipe}` (the new one) | 404 `not_found` (missing, private, or your own) |

A browsed recipe is `{ id, owner, tags, link, fromPhoto, author, picture, en, he }`:
`owner` is the username of who saved it and `tags` its tag **names** (ids mean nothing to
another user). The owner's favorite mark is never sent, nor the calories and protein; a
copy brings them along. `sort` is `newest`, `oldest`, `protein`, `kcal_high`, `kcal_low`
or `random` (the default, the only one that needs `seed`). `next` is `null` on the last
page and comes back as `after`. How the order and the copy work: [Data](./02_data.md#browse).

## Imports

POST bodies are JSON, except a photo import's, which is multipart.

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/imports` `{url, model?}` | Start an import | 202 `{import}`, or 200 with the one already running | 400 `invalid_request`, `link_invalid`, `link_unsupported`; 409 `already_imported`; 429 `too_many_imports`, `quota` |
| `POST /api/imports/photo`, multipart: 1 to 7 `photo` parts (`image/jpeg\|png\|webp\|heic\|heif`), header `X-Photo-Count` | Start an import from photos of one recipe | 202 `{import}` | 400 `photo_invalid`, `photo_too_many`; 413 `photo_too_big`; 429 `too_many_imports`, `quota`; 502 `photo_upload_failed` |
| `GET /api/imports` | Cards plus model state | 200 `{imports, models}` | |
| `POST /api/imports/:id/retry` `{}` | Try a failed import again, as a new import | 202 `{import}` (the new one) | 400 `invalid_request`; 404; 409 `not_retryable`; 429 `too_many_imports`, `quota` |
| `DELETE /api/imports/:id` | Dismiss the card (and a photo import's waiting pictures) | 200 `{ok}` | 404 |
| `PUT /api/imports/:id/picture[?position=0-6]`, multipart `full` + `thumb` | A browser-made copy of one of a photo import's photos (`position` from 0, in the order sent) | 200 `{ok}` | 400 `picture_invalid` (also a bad position); 413 `picture_too_big`; 404 (not your photo import) |
| `POST /api/recipes/:id/rerun` `{model?}` | Scan an imported recipe's link again; replaces its text when done | 202 `{import}` | 400 `invalid_request`; 404; 409 `not_rerunnable` (manual or photo recipe, or that link is running); 429 `too_many_imports`, `quota` |

- `import` is `{ id, status, stage, link, fromPhoto, title, error, retryable, recipeId, recipeName }`.
  `status` is `running`, `failed` or `done`; `stage` is `meta`, `video`, `extract` or
  `save`. `link` is the stored link, which for a share link becomes the post's own link
  once the import has followed it; for photos it is `''` and `fromPhoto` is `true`
  (`title` stays `null`). `recipeName` is `{ en, he }`, or `null` until there is a recipe.
  `error` is set only when failed: the codes are in [Import → Failures](./04_import.md#failures).
- `GET` returns running, failed and done rows, newest first, never dismissed ones or the
  AI tools' rows. It also marks running rows with no update for 30 minutes as failed
  with `timed_out`.
- `models` is `{ bestAvailable, bestLeftToday, bestLeftForUser, bestAvailableAt, resetsAt }`
  about the best model only, times in epoch ms. `bestAvailable` is false when its shared
  count or this user's daily uses are used up, and `bestAvailableAt` is then the reset
  (`null` while available). `bestLeftForUser` is `null` for the admin. `resetsAt` is when
  every daily limit resets ([Models](./05_models.md)).
- Retry answers `not_retryable` when the same video is already running or saved (for a
  rerun's failure: when its recipe was deleted). How Retry works: [Import → Retries](./04_import.md#retries-and-state).
- `model` is normally left out; `'best'` asks for the best model first. A rerun takes the
  same `model` and follows every rule of a new import except `already_imported`.
- `POST` checks, in order: body, link, a running duplicate, `already_imported`, caps,
  model state (only every import model being out stops it), then insert and start. Caps:
  `IMPORT_MAX_RUNNING` running at once per user (import rows, so Retries and reruns too,
  not the AI tools), and the best model's per-user daily uses. There is no daily count of
  imports.

## AI tools

All three answer 429 `quota` (no model can run), 502 `bad_result` or `llm_error`, and 503
`model_busy` (every model it could use is busy), besides the codes below. What they do:
[AI tools](./06_ai-tools.md).

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/translate` `{from, content, recipeId?}` | Translate one language's text into the other | 200 `{content}` | 400 `invalid_request`, `too_long`, `nothing_to_translate`; 404 (another user's recipe) |
| `POST /api/nutrition` `{content, recipeId?}` | Estimate calories and protein per serving | 200 `{calories, protein}` | 400 `invalid_request`, `too_long`, `no_ingredients`; 404 |
| `POST /api/substitute` `{recipeId, from, index, lang}` | Suggest substitutes for one ingredient | 200 `{substitutes: [{name, amount, note}]}` | 400 `invalid_request` (also an `index` past the list); 404 (not the user's recipe) |

`from` and `lang` are `'en'` or `'he'`. `content` is `{ name, ingredients, steps }` with a
recipe's checks and limits. `recipeId` is optional for translate and nutrition and links the
request row to the recipe. Substitute reads the recipe from the database, so it works only
on the user's own saved recipe; `index` (from 0) points into the `from` language's
ingredients, and `lang` is the language to answer in.
