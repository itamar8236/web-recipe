-- Who a recipe is by (its source: a channel, an account, a chef): adds one optional column
-- to recipes. It starts NULL on every existing recipe, so the code from before this change
-- keeps working.
--
-- Run once, by the owner, from backend/, BEFORE merging the recipe-author PR (the new code
-- reads this column, so every recipe request fails until it exists):
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-22-recipe-author.sql
-- Locally, once, on a local database made before this change (a fresh one made by
-- `npm run db:schema:local` already has the column):
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-22-recipe-author.sql
--
-- Running it twice fails with "duplicate column name" and changes nothing.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

ALTER TABLE recipes ADD COLUMN author TEXT CHECK (length(author) BETWEEN 1 AND 100);
