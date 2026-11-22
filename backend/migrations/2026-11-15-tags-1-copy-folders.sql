-- Folders become tags, step 1 of 2: creates the tags tables and copies every recipe's
-- folder into them. It only adds things, so the code from before tags keeps working.
--
-- Run once, by the owner, from backend/, right BEFORE merging the tags PR:
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-15-tags-1-copy-folders.sql
-- Locally, once, after a `npm run db:pull` made from a production that hasn't had it yet:
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-15-tags-1-copy-folders.sql
-- Then, once the new code is deployed, run step 2 (2026-11-22-drop-folders.sql).
--
-- What it copies:
--   * Each folder that holds at least one recipe becomes a tag with the folder's id and
--     name. An empty folder is not copied: a tag exists only while a recipe has it.
--   * Folders of one user with the same name (ignoring case) become one tag, the oldest.
--   * Each recipe in a folder gets that folder's tag. A recipe with no folder gets none.
-- A folder change made with the old code after this ran is not copied, which is why it
-- runs right before the merge. Running it again is harmless, but a recipe moved between
-- folders in the meantime would then hold both tags.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name    TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS recipe_tags (
  recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, tag_id)
);

CREATE INDEX IF NOT EXISTS recipe_tags_tag_id ON recipe_tags (tag_id);

-- With MIN(id), SQLite takes the name from that same (oldest) folder.
INSERT OR IGNORE INTO tags (id, user_id, name)
  SELECT MIN(id), user_id, trim(name)
  FROM folders
  WHERE id IN (SELECT folder_id FROM recipes)
  GROUP BY user_id, trim(name) COLLATE NOCASE;

INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id)
  SELECT recipes.id, tags.id
  FROM recipes
  JOIN folders ON folders.id = recipes.folder_id
  JOIN tags ON tags.user_id = recipes.user_id AND tags.name = trim(folders.name);
