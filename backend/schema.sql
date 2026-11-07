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
-- acting_as_user_id is admin impersonation: while it is set, the admin's session sees
-- and changes that user's folders and recipes exactly as the user would. It lives on the
-- session (not the user) so it applies only on the admin's device, ends when the admin
-- taps "Stop", and never touches the user's own sessions. user_id stays the admin, so
-- the backend always knows who is really acting. Deleting the impersonated user sets it
-- back to NULL, returning the admin to their own data.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash        TEXT    PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acting_as_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CHECK (acting_as_user_id IS NULL OR acting_as_user_id <> user_id)
);

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_acting_as_user_id ON sessions (acting_as_user_id);
CREATE INDEX IF NOT EXISTS sessions_last_seen_at ON sessions (last_seen_at);

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
BEFORE UPDATE OF acting_as_user_id ON sessions
WHEN NEW.acting_as_user_id IS NOT NULL
  AND (SELECT is_admin FROM users WHERE id = NEW.user_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'Only the admin can act as another user');
END;

-- Each user's own folders: nobody else sees them. parent_id nests them and position
-- orders siblings (the user drags them freely). The composite foreign keys
-- (parent_id, user_id) and, in recipes, (folder_id, user_id) make the database refuse
-- to put a folder or recipe inside another user's folder. They are NO ACTION (checked
-- at the end of each statement), which is what makes "only an empty folder can be
-- deleted" a database rule while still letting a user's deletion cascade through all
-- of their folders and recipes in one go. The backend must also refuse to move a folder
-- under one of its own descendants (SQLite triggers cannot run the recursive query
-- needed to check that).
CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  parent_id  INTEGER CHECK (parent_id IS NULL OR parent_id <> id),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (id, user_id),
  FOREIGN KEY (parent_id, user_id) REFERENCES folders (id, user_id)
);

CREATE INDEX IF NOT EXISTS folders_user_parent_position ON folders (user_id, parent_id, position);

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
