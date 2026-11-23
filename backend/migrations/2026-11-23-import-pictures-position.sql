-- Several photos per photo import: import_pictures holds one row per photo, keyed by the
-- import and the photo's position (from 0), instead of one row per import. SQLite can't
-- change a primary key, so the table is rebuilt; the pictures waiting now are kept, as
-- position 0.
--
-- Run once, by the owner, from backend/, just BEFORE merging the several-photos PR. Until
-- the new code is deployed, the old code can't store a photo import's picture (its upsert
-- names the old key), so a photo recipe started in those minutes gets no picture; its
-- recipe is still saved. The other way round would be worse: the new code fails every
-- picture upload until this runs.
--   npx wrangler d1 execute recipes-db --remote --file=migrations/2026-11-23-import-pictures-position.sql
-- Locally, once, on a local database made before this change (a fresh one made by
-- `npm run db:schema:local` already has the new table):
--   npx wrangler d1 execute recipes-db --local --file=migrations/2026-11-23-import-pictures-position.sql
--
-- Run it once only: a second run would move every waiting picture to position 0 (or fail,
-- changing nothing, when an import has several waiting).
--
-- No BEGIN/COMMIT: D1 rejects transaction statements in files and runs the file as one unit.

CREATE TABLE import_pictures_new (
  request_id INTEGER NOT NULL REFERENCES llm_requests (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 6),
  full       BLOB    NOT NULL CHECK (typeof(full) = 'blob' AND length(full) BETWEEN 1 AND 1000000),
  thumb      BLOB    NOT NULL CHECK (typeof(thumb) = 'blob' AND length(thumb) BETWEEN 1 AND 100000),
  type       TEXT    NOT NULL CHECK (type IN ('image/jpeg', 'image/webp')),
  PRIMARY KEY (request_id, position)
);

INSERT INTO import_pictures_new (request_id, position, full, thumb, type)
SELECT request_id, 0, full, thumb, type FROM import_pictures;

DROP TABLE import_pictures;

ALTER TABLE import_pictures_new RENAME TO import_pictures;
