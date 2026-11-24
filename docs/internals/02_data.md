# Data

Cloudflare D1 database `recipes-db`, bound as `env.DB`. Every table, column and
constraint is in [`backend/schema.sql`](../../backend/schema.sql), with comments on why;
this page holds the rules that span tables. Owner steps (refreshing local data,
migrations on production) are in the [database runbook](../operations/00_database.md).

## Ownership

- Every user has their own tags and recipes; nobody changes another user's. Other users
  can only read a **public** recipe (`recipes.is_public`), through Browse, and copy it.
- Deleting a user deletes all their data at once, Recently deleted and pictures included.

## Tags

A flat list per user (`tags`), linked through `recipe_tags`. A name is unique per user,
ignoring the case of English letters. **A tag exists only while a recipe has it**: there is
no create or delete endpoint, and removing a tag from its last recipe deletes it. Renaming
onto another tag's name is refused (`tag_exists`), never a silent merge.

## Recipes

Stored in **both English and Hebrew** so either can be edited. Tags are set on their own,
never with the text. The favorite is a flag on the recipe, since it is the owner's own mark
and is never shown to others. `machine_translated_lang` records which language an import's
model filled in as a translation; editing that language clears it, and the API never
returns it.

## Recently deleted

Deleting a recipe moves it, in one batch, into `deleted_recipes`: a JSON snapshot of the row
(every column but its id) with its **tag names**, and its picture into
`deleted_recipe_pictures`. Tags are kept by name because a tag left on no recipe is still
deleted at once.

- **Restore** (30 days) brings back everything: text, link, model, author, favorite, public
  flag, calories, protein and picture. Each tag is found again by name (whatever its case
  now) or created. It gets a **new id**, so it shows first in "Newest first" and an old
  `/recipe?id=<old>` link no longer finds it.
- **Purge**: the daily Cron Trigger (`triggers.crons` in `wrangler.jsonc`) runs
  `scheduled()` in `src/index.js`, which deletes for good every row older than 30 days with
  its picture. The list and restore already ignore those, so a late run never shows one.
- A binned recipe doesn't count as saved, so its link can be imported again meanwhile;
  restoring it then gives two recipes.

## Model requests

`llm_requests` holds **one row per request** a user makes, with a `purpose`: `import` (a new
import, each Retry, each re-scan), `translation`, `nutrition` or `substitution`; the last
three link their recipe by `recipe_id`. Imports live here rather than in `recipes`, so an
unfinished import never appears as a recipe. Rows stay after they finish, because they are
the record of who used the models and the caps count them: `model` is the model whose answer
the request ended with (also for a failed one), and a user's best-model uses are their rows
with `used_best = 1`.

`llm_usage` is the app's own count of requests per Pacific day and model, shared by all
users. It counts every request to a provider, including a Workflow's quick retries inside
one row ([Models → Quota](./05_models.md#quota)).

## Browse

- Every public recipe of every other user shows. A copy keeps **no link to its original**
  (the owner's choice), so a recipe the user already saved shows again, another user's
  public copy shows beside the original, and saving one twice makes two copies.
- **Random order with no stored state**: the browser picks `seed` once per visit and the
  order is by `(id + seed)³ mod 1000003`. Every order, random included, is "a key, smallest
  first, then the id" (a "most first" key is negated), so they share one query and one
  `next`. `next` is the last recipe's place in that order, not a count, so a recipe deleted
  or made private meanwhile never makes a page skip or repeat one. Recipes with no calories
  or protein come after all that have them; ties go oldest first.
- **Copy**: the same text, link, platform, model, author, calories, protein and picture; no
  favorite; public or private by the user's `defaultPublic`. With `copyTags` on, each tag
  is found by name among the user's own or created. Later changes to either don't reach the
  other.

## Schema changes

- `schema.sql` only uses `IF NOT EXISTS`, so applying it again is safe, but it only creates
  what is missing. **Changing an existing table** also needs a one-off file in
  [`backend/migrations/`](../../backend/migrations) that the owner runs once on production
  (each file says how at its top). The PR says when to run it relative to the merge and what
  breaks meanwhile.
- Nothing records which migrations production has applied, and there is no rollback step:
  a file's name gives its date, and its PR says when it ran.

## Known gaps and accepted trade-offs

- Migrations aren't tracked and have no rollback (above).
- Production still has an empty `folders` table and an always-NULL `recipes.folder_id` from
  before tags. Dropping them needs a rebuild of `recipes`, so they stay (`schema.sql` →
  recipes). New databases don't have them.
- PR previews use the production database ([Deploy](../operations/01_deploy.md)).
