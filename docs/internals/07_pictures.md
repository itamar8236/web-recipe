# Pictures

A recipe has at most **one picture**, and it is **never an AI-made picture of the dish**.
`backend/src/pictures.js` is the only backend file that touches picture bytes;
`frontend/lib/picture.js` (`makePicture`) makes the ones the browser sends. Endpoints:
[API → Tags and recipes](./01_api.md#tags-and-recipes).

## Storage

Pictures are stored **already resized** as BLOBs in D1's `recipe_pictures`: a `full` one for
the recipe's page and a `thumb` for the Home and Browse cards (the card crops it to a square),
so no view ever resizes. Keeping them in D1 means deleting a user deletes them and copying a
recipe is one statement. A deleted recipe's picture moves to `deleted_recipe_pictures` with it.

- **Size**: about 165 KB a recipe at most. D1's free 500 MB is per database and shared with
  the recipes, so about 3,000 recipes with pictures; one BLOB (and row) is at most 2 MB. If it
  ever gets close, `recipe_pictures` can move to a second D1 database in a one-off copy.
- `edited` says who chose it: 0 for an import's picture, 1 for one the user chose; a copy from
  Browse keeps the original's.

## A link's picture

Each adapter's `fetchPost` returns `pictureUrls`, best first: YouTube's thumbnails, built from
the video id (no API call); the `og:image` of the Facebook or Instagram post page the import
already fetched; a web page's `og:image` (or `twitter:image`). Meta's are signed links that
expire in days, so pictures are always **copied, never linked**. The save stage keeps the
addresses in `state`, and the `picture` step, a Workflow step of its own after the save,
fetches the first that works, resizes it, saves it and clears `state`.

- The fetch follows the web-page rules ([Import → Web pages](./04_import.md#web-pages)):
  `redirect: 'manual'`, `isFetchableUrl` at every hop, image types only (never SVG), a size
  cap and a timeout.
- **A picture never fails an import**: anything that goes wrong is logged and the recipe stays
  without one.
- **Resizing is done by Cloudflare's Images binding** (`env.IMAGES`, also under `previews`),
  since the Worker can't decode an image within its CPU time. Free plan: 5,000
  transformations a month, 2 per import; past that it fails (error 9422, never a bill) and the
  recipe has no picture. `wrangler dev` and the tests run it offline with the same results for
  what we use.

## Pictures the browser makes

The edit form's picture and a photo import's copies are drawn by the browser with a canvas
(respecting the photo's EXIF rotation), each under the backend's limits, and never use the
Images binding.

### Photo imports

The originals go only to Gemini. Right after the 202, the browser sends a copy of each photo
(`PUT /api/imports/:id/picture?position=<n>`), one at a time. They wait in `import_pictures`
while the import runs (or failed, for a Retry). The save stage's batch moves the one the model
chose (`cover`) to the recipe and deletes the rest; a Retry moves them to its new row;
dismissing deletes them. If the import already finished when a copy arrives, the chosen one
goes to the recipe at once and the others are ignored.

## Re-scans

A re-scan replaces a picture only when `edited` is 0 (or fills a missing one); a picture the
user chose stays (`savePictureStatement`, which also keeps a link's picture from overwriting
one the user saved at the same moment). A re-scan whose link has no picture keeps the old one.
"Remove picture" deletes the row, so a later re-scan brings the link's picture back. A photo
recipe has no link, so it is never scanned again.

## Known gaps and accepted trade-offs

- A web page opened by Google (it blocked the Worker), or one with no `og:image`, gives its
  recipe no picture; the user can add one.
- A photo import's picture is made by the browser, so a HEIC photo the browser can't draw
  (every browser but Safari) gives the recipe no picture; in the edit form it shows
  `picture_invalid`.
- A recipe imported before pictures existed has none until the user adds one or scans its link
  again. Filling them in bulk is left to a separate script the owner runs.
