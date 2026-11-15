-- Folders become tags, step 2 of 2: removes recipes.folder_id and the folders table, which
-- nothing uses once the tags code is deployed.
--
-- Run once, by the owner, from backend/, AFTER the tags PR is merged and deployed, and
-- after step 1 (2026-11-15-tags-1-copy-folders.sql). The code from before tags does not
-- work once this ran; the tags code works both before and after it.
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-15-tags-2-drop-folders.sql
-- Locally, right after step 1:
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-15-tags-2-drop-folders.sql
-- Run it only once: a second run stops at its first statement that reads folder_id.
--
-- SQLite can't drop a column that a foreign key uses, so the recipes table is rebuilt.
-- Dropping the old table deletes its rows first, and that fires the foreign keys pointing
-- at it: recipe_tags' ON DELETE CASCADE would delete every recipe's tags, and
-- llm_requests.recipe_id's ON DELETE SET NULL would unlink every finished import from its
-- recipe. So both are saved before the drop and put back after it. Nothing else refers
-- to recipes.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE recipes_rebuilt (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
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
  CHECK (trim(name_en) <> '' OR trim(name_he) <> ''),
  CHECK ((platform = 'manual') = (source_url IS NULL)),
  CHECK (platform <> 'manual' OR source_model IS NULL)
);

-- Reading folder_id here is also the guard against a second run: the column is gone then.
INSERT INTO recipes_rebuilt (id, user_id, is_favorite, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, created_at, updated_at)
  SELECT id, user_id, is_favorite, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, created_at, updated_at
  FROM recipes
  WHERE folder_id IS NULL OR folder_id IS NOT NULL;

CREATE TABLE llm_requests_recipe_links AS
  SELECT id, recipe_id FROM llm_requests WHERE recipe_id IS NOT NULL;

CREATE TABLE recipe_tags_saved AS
  SELECT recipe_id, tag_id FROM recipe_tags;

DROP TABLE recipes;

ALTER TABLE recipes_rebuilt RENAME TO recipes;

CREATE INDEX recipes_user_id ON recipes (user_id);

INSERT INTO recipe_tags (recipe_id, tag_id)
  SELECT recipe_id, tag_id FROM recipe_tags_saved;

DROP TABLE recipe_tags_saved;

UPDATE llm_requests
   SET recipe_id = (SELECT recipe_id FROM llm_requests_recipe_links WHERE llm_requests_recipe_links.id = llm_requests.id)
 WHERE id IN (SELECT id FROM llm_requests_recipe_links);

DROP TABLE llm_requests_recipe_links;

DROP TABLE folders;
