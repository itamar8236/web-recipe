-- Lets a recipe come from Instagram (or any later site): removes the list CHECK on
-- recipes.platform, which allowed only 'manual', 'youtube' and 'facebook'.
--
-- Run once, by the owner, from backend/, BEFORE the code that imports from Instagram is
-- deployed (the older code works with the rebuilt table too):
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-13-recipes-any-platform.sql
-- Locally, once, after a `npm run db:pull` made from a production that hasn't had it yet:
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-13-recipes-any-platform.sql
-- Running it a second time is harmless: it rebuilds the table again with the same result.
--
-- SQLite can't change a CHECK, so the table is rebuilt. Dropping the old table deletes its
-- rows first, and that fires llm_requests.recipe_id's ON DELETE SET NULL, which would
-- unlink every finished import from its recipe. So those links are saved before the drop
-- and put back after it. Nothing else refers to recipes.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE recipes_rebuilt (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder_id      INTEGER,
  is_favorite    INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  platform       TEXT    NOT NULL DEFAULT 'manual',
  source_url     TEXT,
  source_model   TEXT,
  name_en        TEXT    NOT NULL DEFAULT '',
  ingredients_en TEXT    NOT NULL DEFAULT '[]'
                 CHECK (json_valid(ingredients_en) AND json_type(ingredients_en) = 'array'),
  steps_en       TEXT    NOT NULL DEFAULT '[]'
                 CHECK (json_valid(steps_en) AND json_type(steps_en) = 'array'),
  name_he        TEXT    NOT NULL DEFAULT '',
  ingredients_he TEXT    NOT NULL DEFAULT '[]'
                 CHECK (json_valid(ingredients_he) AND json_type(ingredients_he) = 'array'),
  steps_he       TEXT    NOT NULL DEFAULT '[]'
                 CHECK (json_valid(steps_he) AND json_type(steps_he) = 'array'),
  machine_translated_lang TEXT CHECK (machine_translated_lang IN ('en', 'he')),
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY (folder_id, user_id) REFERENCES folders (id, user_id),
  CHECK (trim(name_en) <> '' OR trim(name_he) <> ''),
  CHECK ((platform = 'manual') = (source_url IS NULL)),
  CHECK (platform <> 'manual' OR source_model IS NULL)
);

INSERT INTO recipes_rebuilt (id, user_id, folder_id, is_favorite, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, created_at, updated_at)
  SELECT id, user_id, folder_id, is_favorite, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, created_at, updated_at
  FROM recipes;

CREATE TABLE llm_requests_recipe_links AS
  SELECT id, recipe_id FROM llm_requests WHERE recipe_id IS NOT NULL;

DROP TABLE recipes;

ALTER TABLE recipes_rebuilt RENAME TO recipes;

CREATE INDEX recipes_user_folder ON recipes (user_id, folder_id);

UPDATE llm_requests
   SET recipe_id = (SELECT recipe_id FROM llm_requests_recipe_links WHERE llm_requests_recipe_links.id = llm_requests.id)
 WHERE id IN (SELECT id FROM llm_requests_recipe_links);

DROP TABLE llm_requests_recipe_links;
