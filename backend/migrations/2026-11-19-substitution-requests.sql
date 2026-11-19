-- Lets llm_requests record an ingredient-substitutes request as its own purpose: adds
-- 'substitution' to the purpose CHECK, which allowed only 'import', 'translation' and
-- 'nutrition'.
--
-- Run once, by the owner, from backend/, BEFORE merging the AI-tools-box PR (the new code
-- inserts purpose 'substitution', which the old table refuses, so "Substitute an
-- ingredient" fails until this runs; the older code works with the rebuilt table too):
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-19-substitution-requests.sql
-- Locally, once, on a local database made before this change (a fresh one made by
-- `npm run db:schema:local` already allows it):
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-19-substitution-requests.sql
--
-- Running it twice is harmless: it rebuilds the table again with the same rows.
--
-- SQLite can't change a CHECK, so the table is rebuilt. Nothing refers to llm_requests, so
-- dropping it touches no other table. Its rows keep their ids.
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE llm_requests_rebuilt (
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

INSERT INTO llm_requests_rebuilt (id, user_id, purpose, platform, source_id, source_url, title,
    status, stage, attempt, state, error, error_detail, model, recipe_id, replace_recipe_id,
    used_best, quota_day, created_at, updated_at)
  SELECT id, user_id, purpose, platform, source_id, source_url, title,
    status, stage, attempt, state, error, error_detail, model, recipe_id, replace_recipe_id,
    used_best, quota_day, created_at, updated_at
  FROM llm_requests;

DROP TABLE llm_requests;

ALTER TABLE llm_requests_rebuilt RENAME TO llm_requests;

CREATE INDEX llm_requests_user_status ON llm_requests (user_id, status);

CREATE UNIQUE INDEX llm_requests_one_running
  ON llm_requests (user_id, platform, source_id) WHERE status = 'running';
