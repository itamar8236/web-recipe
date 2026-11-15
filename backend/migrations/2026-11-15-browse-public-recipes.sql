-- Browsing other users' recipes: adds the public/private flag and the copy link to
-- recipes, and the two per-user defaults to users. It only adds columns with defaults, so
-- the code from before browsing keeps working.
--
-- Run once, by the owner, from backend/, BEFORE merging the browsing PR (the new code
-- reads these columns, so every request fails until they exist):
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-15-browse-public-recipes.sql
-- Locally, once, on a local database made before this change (a fresh one made by
-- `npm run db:schema:local` already has the columns):
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-15-browse-public-recipes.sql
--
-- Every existing recipe becomes public, and every existing user gets both defaults on
-- (new recipes public, tags copied), as the owner decided.
-- Running it twice fails with "duplicate column name" and changes nothing.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

ALTER TABLE recipes ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1));
ALTER TABLE recipes ADD COLUMN copied_from INTEGER;
ALTER TABLE users ADD COLUMN default_public INTEGER NOT NULL DEFAULT 1 CHECK (default_public IN (0, 1));
ALTER TABLE users ADD COLUMN copy_tags INTEGER NOT NULL DEFAULT 1 CHECK (copy_tags IN (0, 1));
