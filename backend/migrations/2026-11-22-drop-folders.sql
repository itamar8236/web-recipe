-- Removes what is left of folders (replaced by tags): recipes.folder_id and the folders
-- table. No code uses either, so it can run before or after any deploy.
--
-- Run once, by the owner, from backend/:
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-22-drop-folders.sql
-- Locally, only on a database that still has a folders table:
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-22-drop-folders.sql
-- A second run fails at DROP TABLE folders and changes nothing.
--
-- SQLite can't drop a column a foreign key uses, and recipes can't keep pointing at a
-- dropped table, so recipes is rebuilt. Dropping the old recipes table would delete every
-- recipe's tags and unlink every import from its recipe (their foreign keys), so both are
-- saved first and put back after.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE recipe_tags_saved AS SELECT recipe_id, tag_id FROM recipe_tags;
CREATE TABLE llm_links_saved AS SELECT id, recipe_id FROM llm_requests WHERE recipe_id IS NOT NULL;

-- The same as recipes in schema.sql.
CREATE TABLE recipes_new (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_favorite    INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  is_public      INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
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
  calories       INTEGER CHECK (calories BETWEEN 0 AND 10000),
  protein        INTEGER CHECK (protein BETWEEN 0 AND 1000),
  author         TEXT    CHECK (length(author) BETWEEN 1 AND 100),
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CHECK (trim(name_en) <> '' OR trim(name_he) <> ''),
  CHECK ((platform = 'manual') = (source_url IS NULL)),
  CHECK (platform <> 'manual' OR source_model IS NULL)
);

INSERT INTO recipes_new (id, user_id, is_favorite, is_public, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, calories, protein, author, created_at, updated_at)
  SELECT id, user_id, is_favorite, is_public, platform, source_url, source_model,
    name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
    machine_translated_lang, calories, protein, author, created_at, updated_at
  FROM recipes;

DROP TABLE recipes;
ALTER TABLE recipes_new RENAME TO recipes;
CREATE INDEX recipes_user_id ON recipes (user_id);
DROP TABLE folders;

INSERT INTO recipe_tags (recipe_id, tag_id) SELECT recipe_id, tag_id FROM recipe_tags_saved;
UPDATE llm_requests
   SET recipe_id = (SELECT recipe_id FROM llm_links_saved WHERE llm_links_saved.id = llm_requests.id)
 WHERE id IN (SELECT id FROM llm_links_saved);

DROP TABLE recipe_tags_saved;
DROP TABLE llm_links_saved;
