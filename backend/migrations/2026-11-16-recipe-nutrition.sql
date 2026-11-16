-- Calories and protein per serving: adds two optional columns to recipes. They start NULL
-- on every existing recipe, so the code from before this change keeps working.
--
-- Run once, by the owner, from backend/, BEFORE merging the calories-and-protein PR (the
-- new code reads these columns, so every recipe request fails until they exist):
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-16-recipe-nutrition.sql
-- Locally, once, on a local database made before this change (a fresh one made by
-- `npm run db:schema:local` already has the columns):
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-16-recipe-nutrition.sql
--
-- Running it twice fails with "duplicate column name" and changes nothing.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

ALTER TABLE recipes ADD COLUMN calories INTEGER CHECK (calories BETWEEN 0 AND 10000);
ALTER TABLE recipes ADD COLUMN protein INTEGER CHECK (protein BETWEEN 0 AND 1000);
