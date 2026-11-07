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
-- produced by the backend's password helper (a script/endpoint for this is planned);
-- never put a plaintext password here.
--   npx wrangler d1 execute recipes-db --remote --command="INSERT INTO users (username, is_admin, password_hash) VALUES ('<admin-username>', 1, '<password-hash>')"

-- People who may log in. There is no sign-up: the admin adds rows here with a password,
-- and a login matches the username plus the password.
-- password_hash keeps the PBKDF2 iterations and salt inside the string, so iterations can
-- be raised later and old hashes still verify.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE
                CHECK (length(username) BETWEEN 1 AND 50 AND username = trim(username)),
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  -- The prefix check rejects a plaintext password stored here by mistake.
  password_hash TEXT    NOT NULL CHECK (password_hash LIKE 'pbkdf2-sha256$%$%$%'),
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
-- and changes that user's folders and recipes exactly as the user would. It lives on the
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

-- Each user's own folders (a flat list): nobody else sees them. UNIQUE (id, user_id) lets
-- recipes use a composite foreign key, so the database refuses to put a recipe in another
-- user's folder. That key is NO ACTION, which makes "only an empty folder can be deleted"
-- a database rule while still letting a user's deletion cascade through all of their
-- folders and recipes in one go.
CREATE TABLE IF NOT EXISTS folders (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name    TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS folders_user_id ON folders (user_id);

-- Each user's own recipes, in both languages side by side. Two fixed languages fit in
-- one row, so a recipe is read and saved in one statement. Either language may be empty
-- ('' and '[]') until it is written or translated, but at least one name is set.
-- folder_id NULL means "No folder". source_url NULL means added manually.
-- is_favorite is a plain column because only the owner ever sees a recipe, so "my
-- favorite" and "favorite" are the same thing.
-- source_model is the LLM whose result the user picked on the compare screen (NULL for
-- manual recipes); it is all an import needs to remember once the recipe is saved.
-- machine_translated_lang names the language the LLM filled in, so the UI can label it;
-- the backend clears it when the user edits that language, since it is then human text.
CREATE TABLE IF NOT EXISTS recipes (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder_id      INTEGER,
  is_favorite    INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  platform       TEXT    NOT NULL DEFAULT 'manual'
                 CHECK (platform IN ('manual', 'youtube', 'facebook')),
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
  -- A manual recipe has no link and no model; an imported one always has its video link.
  CHECK ((platform = 'manual') = (source_url IS NULL)),
  CHECK (platform <> 'manual' OR source_model IS NULL)
);

CREATE INDEX IF NOT EXISTS recipes_user_folder ON recipes (user_id, folder_id);
