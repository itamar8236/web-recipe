-- web-recipe database schema for Cloudflare D1 (database: recipes-db).
--
-- How to apply:
--   Production (once, by the owner, from backend/):
--     npx wrangler d1 execute recipes-db --remote --file=schema.sql
--   Local dev: `npm run dev` (scripts/db-pull.mjs) applies it on top of a fresh copy of
--   production every time, and `npm run db:schema:local` applies it on its own.
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
--     so "older than N days" is plain arithmetic and sorting is numeric. The DEFAULT is
--     only a safety net; the backend passes its own Date.now().
--   * Ingredients and steps are JSON arrays of strings stored as TEXT. They are always
--     read and written whole with their recipe, never searched or joined on, so a JSON
--     array is the simplest shape that keeps their order.
--   * Booleans are INTEGER 0/1.
--
-- Bootstrap the admin (once, on production, replacing the placeholders). Only one admin
-- can exist, and the admin row cannot be deleted or demoted (see the users triggers).
-- <password-hash> is the full encoded string 'pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>'
-- produced by the backend's password helper (a script/endpoint for this is planned);
-- never put a plaintext password here. must_change_password = 1 makes the owner pick a
-- new password on first login, so the bootstrap one never stays in shell history for long.
--   npx wrangler d1 execute recipes-db --remote --command="INSERT INTO users (username, email, is_admin, password_hash, must_change_password) VALUES ('<admin-username>', '<admin-email-or-NULL>', 1, '<password-hash>', 1)"

-- People who may log in. There is no sign-up: the admin adds rows here with an initial
-- password, and a login matches the username or the email plus the password. Usernames
-- cannot contain '@' and emails must, so a login string can never match one user's
-- username and another user's email at the same time.
-- password_hash keeps the PBKDF2 iterations and salt inside the string, so iterations can
-- be raised later and old hashes still verify (and get re-hashed on the next login).
-- must_change_password is set when the admin creates or resets a password, so only the
-- user ever knows their real password.
-- failed_login_count/locked_until slow down password guessing: after a few wrong tries
-- the backend locks the account for a short time and resets the count on success. These
-- live on users rather than in a login_attempts table because there are at most 50
-- accounts and logins for unknown names have no account to guess into; a table would
-- only add rows to clean up.
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE
                       CHECK (length(username) BETWEEN 1 AND 50
                              AND username = trim(username)
                              AND instr(username, '@') = 0),
  email                TEXT    UNIQUE COLLATE NOCASE
                       CHECK (email IS NULL
                              OR (length(email) <= 254 AND email = trim(email)
                                  AND instr(email, '@') > 1)),
  is_admin             INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  -- The prefix check rejects a plaintext password stored here by mistake.
  password_hash        TEXT    NOT NULL CHECK (password_hash LIKE 'pbkdf2-sha256$%$%$%'),
  password_updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  failed_login_count   INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         INTEGER,
  created_at           INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
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

-- The product allows up to 50 users; the backend shows a friendly message first, this
-- is the guarantee.
CREATE TRIGGER IF NOT EXISTS users_max_50
BEFORE INSERT ON users
WHEN (SELECT COUNT(*) FROM users) >= 50
BEGIN
  SELECT RAISE(ABORT, 'User limit reached (50)');
END;

-- One row per logged-in device, so a login is remembered and the password is typed only
-- once per device. Only the SHA-256 hash of the cookie token is stored, so a leaked
-- database cannot be used to log in. Deleting a user cascades here, which logs them out
-- everywhere at once; changing or resetting a password deletes that user's other
-- sessions the same way (done by the backend). Sessions
-- unused for a long time are deleted by the backend
-- (DELETE FROM sessions WHERE last_seen_at < ?), using last_seen_at so active users
-- are never logged out.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_last_seen_at ON sessions (last_seen_at);

-- Shared folders that organize the shared recipes. parent_id nests them and position
-- orders siblings (the user drags them freely). RESTRICT on parent_id (and on
-- recipes.folder_id) is what makes "only an empty folder can be deleted" a database
-- rule. The backend must also refuse to move a folder under one of its own descendants
-- (SQLite triggers cannot run the recursive query needed to check that).
CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  parent_id  INTEGER REFERENCES folders (id) ON DELETE RESTRICT
             CHECK (parent_id IS NULL OR parent_id <> id),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_by INTEGER REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS folders_parent_position ON folders (parent_id, position);

-- The shared recipe collection, in both languages side by side. Two fixed languages fit
-- in one row, so a recipe is read and saved in one statement. Either language may be
-- empty ('' and '[]') until it is written or translated, but at least one name is set.
-- folder_id NULL means "No folder". source_url NULL means added manually.
-- machine_translated_lang names the language the LLM filled in, so the UI can label it;
-- the backend clears it when a user edits that language, since it is then human text.
-- created_by/updated_by become NULL when that user is deleted: the recipe stays.
CREATE TABLE IF NOT EXISTS recipes (
  id             INTEGER PRIMARY KEY,
  folder_id      INTEGER REFERENCES folders (id) ON DELETE RESTRICT,
  platform       TEXT    NOT NULL DEFAULT 'manual'
                 CHECK (platform IN ('manual', 'youtube', 'facebook')),
  source_url     TEXT,
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
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  CHECK (trim(name_en) <> '' OR trim(name_he) <> ''),
  -- A manual recipe has no link and an imported one always has its video link.
  CHECK ((platform = 'manual') = (source_url IS NULL))
);

CREATE INDEX IF NOT EXISTS recipes_folder_id ON recipes (folder_id);

-- Hearts are per user: everyone shares one collection, so one person's favorites must
-- not change what another person sees under "Favorites". A row means "this user hearted
-- this recipe"; deleting the user or the recipe removes it.
CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipe_id  INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, recipe_id)
) WITHOUT ROWID;

-- One video import a user started. An import runs several free-tier LLMs and can take a
-- minute; keeping the attempt lets the compare screen survive a reload or a phone
-- switching apps without spending the models' free quota again. These rows are drafts,
-- not recipes: a recipe is created only when the user picks a candidate and saves
-- (saved_recipe_id then points at it). Discarding an import deletes its row; the backend
-- also deletes runs older than a few days. folder_id is only the folder picked on the
-- import screen, so it is SET NULL rather than blocking a folder delete.
CREATE TABLE IF NOT EXISTS import_runs (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform        TEXT    NOT NULL CHECK (platform IN ('youtube', 'facebook')),
  source_url      TEXT    NOT NULL,
  folder_id       INTEGER REFERENCES folders (id) ON DELETE SET NULL,
  saved_recipe_id INTEGER REFERENCES recipes (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS import_runs_user_created ON import_runs (user_id, created_at);

-- One model's answer within an import, shown side by side on the compare screen with
-- the model name, time taken, and error. 'running' rows let a reloaded screen show which
-- models are still working; 'no_recipe' is separate from 'error' so the UI can say
-- "this video has no recipe" in the user's language. result is the whole draft
-- ({"en": {name, ingredients, steps}, "he": {...}}) as JSON because it is only ever shown
-- and copied whole into recipes.
CREATE TABLE IF NOT EXISTS import_candidates (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES import_runs (id) ON DELETE CASCADE,
  model       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'ok', 'no_recipe', 'error')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error       TEXT,
  result      TEXT,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (run_id, model),
  CHECK ((status = 'ok') = (result IS NOT NULL)),
  CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
  CHECK ((status = 'error') = (error IS NOT NULL))
);
