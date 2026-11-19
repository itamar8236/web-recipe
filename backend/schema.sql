-- web-recipe database schema for Cloudflare D1 (database: recipes-db).
--
-- How to apply:
--   Production (once, by the owner, from backend/):
--     npx wrangler d1 execute recipes-db --remote --file=schema.sql
--   Local dev: `npm run db:schema:local` applies it to the local database
--   (.wrangler/state), which `npm run dev` then uses. That database may or may not be a
--   copy of production: the owner's `npm run db:pull` (scripts/db-pull.mjs) replaces it
--   with one and applies this file on top.
--
-- The file must stay safe to run any number of times: every statement is
-- IF NOT EXISTS, so running it on an up-to-date database changes nothing and running it
-- on an older one only adds the missing tables, indexes and triggers. The flip side:
-- it never alters a table that already exists. Changing a column of an existing table
-- needs its own ALTER statement, run once.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one
-- unit anyway. Foreign keys are always enforced on D1 (and in local wrangler).
--
-- Conventions:
--   * Times are INTEGER Unix epoch milliseconds (what Date.now() returns in the Worker),
--     so sorting is numeric. The DEFAULT is
--     only a safety net; the backend passes its own Date.now().
--   * Ingredients and steps are JSON arrays of strings stored as TEXT. They are always
--     read and written whole with their recipe, never searched or joined on, so a JSON
--     array is the simplest shape that keeps their order.
--   * Booleans are INTEGER 0/1.
--
-- Bootstrap the admin (once, on production, replacing the placeholders). Only one admin
-- can exist, and the admin row cannot be deleted or demoted (see the users triggers).
-- <password-hash> is the full encoded string 'pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>'
-- made once by hand with PBKDF2-SHA256 (100000 iterations, random 16-byte salt, 32-byte hash);
-- never put a plaintext password here.
--   npx wrangler d1 execute recipes-db --remote --file=<file with the INSERT below>
--   INSERT INTO users (username, is_admin, password_hash) VALUES ('<admin-username>', 1, '<password-hash>');

-- People who may log in. Anyone can sign up (POST /api/auth/register) while fewer than 50
-- rows exist, and a login matches the username plus the password.
-- password_hash keeps the PBKDF2 iterations and salt inside the string, so iterations can
-- be raised later and old hashes still verify.
-- default_public and copy_tags are the user's own defaults, changed in "My account":
-- whether a recipe they add starts public (others can browse and copy it) or private, and
-- whether copying someone else's recipe also copies its tags. Both start as yes.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE
                CHECK (length(username) BETWEEN 1 AND 50 AND username = trim(username)),
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  -- The prefix check rejects a plaintext password stored here by mistake.
  password_hash TEXT    NOT NULL CHECK (password_hash LIKE 'pbkdf2-sha256$%$%$%'),
  default_public INTEGER NOT NULL DEFAULT 1 CHECK (default_public IN (0, 1)),
  copy_tags     INTEGER NOT NULL DEFAULT 1 CHECK (copy_tags IN (0, 1)),
  created_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- At most one admin, enforced by the database rather than trusted to the backend.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin ON users (is_admin) WHERE is_admin = 1;

-- Once the admin exists it stays: a bug or a mistaken tap in the Users screen must not
-- leave the app with nobody able to manage users. To hand over the role, drop these two
-- triggers, change the rows, and run this file again to recreate them.
CREATE TRIGGER IF NOT EXISTS users_admin_not_deleted
BEFORE DELETE ON users
WHEN OLD.is_admin = 1
BEGIN
  SELECT RAISE(ABORT, 'The admin cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS users_admin_not_demoted
BEFORE UPDATE OF is_admin ON users
WHEN OLD.is_admin = 1 AND NEW.is_admin = 0
BEGIN
  SELECT RAISE(ABORT, 'The admin cannot be demoted');
END;

-- One row per device (browser), so a login is remembered there and the password is
-- typed only once per device.
-- device_id is a random id the backend puts in a long-lived cookie the first time a
-- browser logs in and keeps across logouts. It is the primary key, so logging in again
-- on the same device replaces that device's row (INSERT ... ON CONFLICT (device_id)
-- DO UPDATE) instead of adding one: rows grow only with new devices.
-- token_hash is the SHA-256 of the login cookie; only the hash is stored, so a leaked
-- database cannot be used to log in. Logging out deletes the row. Deleting a user
-- cascades here, which logs them out everywhere at once.
-- acting_as_user_id is admin impersonation: while it is set, the admin's session sees
-- and changes that user's tags and recipes exactly as the user would. It lives on the
-- session so it applies only on the admin's device and ends when the admin taps "Stop".
-- user_id stays the admin, so the backend always knows who is really acting. Deleting
-- the impersonated user sets it back to NULL.
CREATE TABLE IF NOT EXISTS sessions (
  device_id         TEXT    PRIMARY KEY CHECK (length(device_id) >= 32),
  token_hash        TEXT    NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acting_as_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  CHECK (acting_as_user_id IS NULL OR acting_as_user_id <> user_id)
);

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_acting_as_user_id ON sessions (acting_as_user_id);

-- Only the admin may impersonate. The backend checks this too; these triggers make a
-- missed check impossible to turn into one user reading another's recipes.
CREATE TRIGGER IF NOT EXISTS sessions_only_admin_acts_as_insert
BEFORE INSERT ON sessions
WHEN NEW.acting_as_user_id IS NOT NULL
  AND (SELECT is_admin FROM users WHERE id = NEW.user_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'Only the admin can act as another user');
END;

CREATE TRIGGER IF NOT EXISTS sessions_only_admin_acts_as_update
BEFORE UPDATE ON sessions
WHEN NEW.acting_as_user_id IS NOT NULL
  AND (SELECT is_admin FROM users WHERE id = NEW.user_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'Only the admin can act as another user');
END;

-- Each user's own recipes, in both languages side by side. Two fixed languages fit in
-- one row, so a recipe is read and saved in one statement. Either language may be empty
-- ('' and '[]') until it is written or translated, but at least one name is set.
-- source_url NULL means added manually. Its tags are in recipe_tags.
-- platform is 'manual' or the source an import came from ('youtube', 'facebook',
-- 'instagram', or 'web' for any other web page), or 'photo' for a recipe read from a picture
-- the user uploaded. It has no list CHECK, so adding a site needs no table rebuild; the backend
-- only ever writes the name of one of its own adapters. A photo recipe's source_url is
-- 'photo:<random id>', not a link: it satisfies the CHECK below (only a manual recipe has
-- none), the API answers it as link '' and fromPhoto true, and the id is the key a later
-- feature may keep the picture under. The picture itself is never stored.
-- is_favorite is a plain column because a favorite is the owner's own mark: other users
-- who browse a public recipe never see or change it.
-- is_public says other users may see the recipe in Browse and copy it. Only the owner can
-- ever change the recipe itself. A copy saved from Browse is a plain recipe of its new
-- owner: nothing links it to the one it was copied from.
-- calories (kcal) and protein (grams) are per serving, whole numbers, NULL when not known.
-- An import's model fills them in, and the user can write or change them. They are the
-- same in both languages.
-- source_model is the LLM that produced an imported recipe (NULL for manual recipes).
-- machine_translated_lang names the language an import's model filled in as a translation
-- of the post's own language. Only the backend reads it (the API doesn't return it); it is
-- cleared when the user edits that language, since it is then human text.
CREATE TABLE IF NOT EXISTS recipes (
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
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CHECK (trim(name_en) <> '' OR trim(name_he) <> ''),
  -- A manual recipe has no link and no model; an imported one always has its video link.
  CHECK ((platform = 'manual') = (source_url IS NULL)),
  CHECK (platform <> 'manual' OR source_model IS NULL)
);

CREATE INDEX IF NOT EXISTS recipes_user_id ON recipes (user_id);

-- Each user's own tags: nobody else sees them. A recipe has any number of them (none too),
-- through recipe_tags. The name is NOCASE and unique per user, so "Dinner" and "dinner"
-- are one tag, spelled the way it was first written.
-- A tag exists only while a recipe has it: the backend deletes a tag when its last recipe
-- drops it or is deleted, so there is no "empty tag" to manage.
CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name    TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  UNIQUE (user_id, name)
);

-- Which tags a recipe has. Deleting the recipe or the tag removes the row. The backend
-- never takes a tag id from the browser: it finds or creates the tag by name among the
-- recipe owner's tags, which is what keeps a recipe from getting another user's tag.
CREATE TABLE IF NOT EXISTS recipe_tags (
  recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, tag_id)
);

CREATE INDEX IF NOT EXISTS recipe_tags_tag_id ON recipe_tags (tag_id);

-- One row per request for model work: every import from a link, every Retry (a new row,
-- not the old one restarted), every re-scan of a recipe's video, every translation and every
-- calories estimate and every ingredient-substitutes request.
-- It is the record of who used the models: a user's daily best-model uses are the rows with used_best = 1, whatever their
-- purpose. A separate table rather than unfinished rows in recipes: recipes requires a real
-- name, and every list and search would otherwise need a "ready?" filter.
-- purpose: 'import' (a link: new, Retry or re-scan; shown as a card), 'translation',
-- 'nutrition' (a calories-and-protein estimate) or 'substitution' (substitutes for one
-- ingredient). The last three come from the recipe page's AI tools: text only, no link,
-- never a card; recipe_id is their recipe.
-- Rows stay after finishing (dismissing only sets the status), because the caps count them.
-- platform, source_id and source_url are the link, so only an import has them. platform has
-- no CHECK, so adding a source needs no table rebuild.
-- stage is the stage running now or next, so the card can say what is happening.
-- attempt guards each stage's writes, so a late write from an older Workflow changes
-- nothing. A Retry is a new row, so new rows keep attempt 1.
-- state holds what finished stages produced, so a repeated Workflow step skips them. A
-- Retry's row starts over from the first stage, keeping only the model choice, except
-- after a failed save: it copies that state, which already holds the recipe.
-- error is written before a stage throws, so nothing depends on how Workflows passes
-- errors along. error_detail says why in words (e.g. Google's message), for debugging
-- only: it is never sent to the browser.
-- model is the model whose answer the request ended with (NULL when none answered): for
-- an import the same name as its recipe's source_model, and kept for failed ones too.
-- replace_recipe_id is set on a re-scan. It deliberately has no foreign key: ON DELETE SET
-- NULL would turn a re-scan of a deleted recipe into a new recipe.
-- used_best says this row took one of the user's daily best-model uses (once a request
-- reached the best model, even if another model answered in the end). quota_day is the
-- Pacific date those uses and the caps count for.
CREATE TABLE IF NOT EXISTS llm_requests (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL DEFAULT 'import' CHECK (purpose IN ('import', 'translation', 'nutrition', 'substitution')),
  platform   TEXT,
  source_id  TEXT,
  source_url TEXT,
  title      TEXT,
  status     TEXT    NOT NULL DEFAULT 'running'
             CHECK (status IN ('running', 'done', 'failed', 'dismissed')),
  stage      TEXT    NOT NULL DEFAULT 'meta',
  attempt    INTEGER NOT NULL DEFAULT 1,
  state      TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(state)),
  error      TEXT,
  error_detail TEXT,
  model      TEXT,
  recipe_id  INTEGER REFERENCES recipes (id) ON DELETE SET NULL,
  replace_recipe_id INTEGER,
  used_best  INTEGER NOT NULL DEFAULT 0 CHECK (used_best IN (0, 1)),
  quota_day  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((purpose = 'import') = (platform IS NOT NULL AND source_id IS NOT NULL AND source_url IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS llm_requests_user_status ON llm_requests (user_id, status);

-- A user can't run the same video twice at once. This is what makes a double tap or a
-- second device show the existing card instead of spending another request. Translations
-- have no link (NULLs never clash), so any number may run.
CREATE UNIQUE INDEX IF NOT EXISTS llm_requests_one_running
  ON llm_requests (user_id, platform, source_id) WHERE status = 'running';

-- The app's own count of requests per Pacific day and model, shared by all users because
-- Google's limits are per project: Google offers no documented way to ask how many are
-- left. It counts every request, including a Workflow's own retries. When Google says a
-- model's daily quota is used up, its count is set to the limit, which keeps the model
-- unused until the reset. A new day is a new row, so the count restarts by itself.
CREATE TABLE IF NOT EXISTS llm_usage (
  day   TEXT    NOT NULL,
  model TEXT    NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (day, model)
);
