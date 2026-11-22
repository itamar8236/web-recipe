// "Recently deleted": a deleted recipe waits in deleted_recipes for 30 days, where its owner
// can restore it, and is then deleted for good by the daily cron job (see schema.sql).
// Like data.js, every query is filtered by the logged-in user.

import { RECIPE_COLUMNS, selectTags, toRecipe } from './data.js';
import { fail, json } from './http.js';

export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;

// Every recipes column the snapshot keeps: all but id (a restored recipe gets a new one)
// and user_id (the bin row has its own). A column added to recipes must be added here, or
// a restored recipe loses it.
const SNAPSHOT_COLUMNS = [
  'is_favorite', 'is_public', 'platform', 'source_url', 'source_model',
  'name_en', 'ingredients_en', 'steps_en', 'name_he', 'ingredients_he', 'steps_he',
  'machine_translated_lang', 'calories', 'protein', 'author', 'created_at', 'updated_at',
];

// Copies the recipe and its tag names into the bin. Runs in the same batch as the DELETE,
// so a recipe is never lost and never in both places. Nothing is copied when the recipe
// isn't this user's.
export const moveToBin = (env, userId, id, now) =>
  env.DB.prepare(
    `INSERT INTO deleted_recipes (user_id, recipe, deleted_at)
     SELECT user_id, json_object(${SNAPSHOT_COLUMNS.map((column) => `'${column}', ${column}`).join(', ')},
       'tags', json((SELECT json_group_array(tags.name) FROM recipe_tags JOIN tags ON tags.id = recipe_tags.tag_id
                     WHERE recipe_tags.recipe_id = recipes.id))), ?3
     FROM recipes WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId, now);

// The user's bin, most recently deleted first. Older rows the cron job hasn't removed yet
// are left out, so nothing shows or restores after its 30 days.
async function listDeleted(env, userId) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, json_extract(recipe, '$.name_en') AS name_en, json_extract(recipe, '$.name_he') AS name_he, deleted_at
     FROM deleted_recipes WHERE user_id = ? AND deleted_at > ? ORDER BY deleted_at DESC, id DESC`,
  )
    .bind(userId, now - KEEP_MS)
    .all();
  return json({
    recipes: results.map((row) => ({
      id: row.id,
      en: { name: row.name_en },
      he: { name: row.name_he },
      deletedAt: row.deleted_at,
      expiresAt: row.deleted_at + KEEP_MS,
    })),
  });
}

// Puts the recipe back with its text, favorite, public flag and tags (a tag that was
// deleted meanwhile is created again), in one batch. Answers like setting tags does.
async function restoreDeleted(env, userId, id) {
  const binRow = 'FROM deleted_recipes WHERE id = ?1 AND user_id = ?2 AND deleted_at > ?3';
  const snapshotTags = `json_each((SELECT recipe ${binRow}), '$.tags')`;
  // The restored row has the highest id: SQLite gives a new row the highest id plus one, and
  // the batch runs as one transaction. When the bin row isn't found, every statement below
  // reads nothing from it, so nothing changes.
  const restoredId = '(SELECT MAX(id) FROM recipes WHERE user_id = ?2)';
  const values = [id, userId, Date.now() - KEEP_MS];

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tags (user_id, name) SELECT ?2, value FROM ${snapshotTags} WHERE true ON CONFLICT DO NOTHING`,
    ).bind(...values),
    env.DB.prepare(
      `INSERT INTO recipes (user_id, ${SNAPSHOT_COLUMNS.join(', ')})
       SELECT user_id, ${SNAPSHOT_COLUMNS.map((column) => `json_extract(recipe, '$.${column}')`).join(', ')} ${binRow}`,
    ).bind(...values),
    env.DB.prepare(
      `INSERT INTO recipe_tags (recipe_id, tag_id)
       SELECT ${restoredId}, id FROM tags WHERE user_id = ?2 AND name IN (SELECT value FROM ${snapshotTags})`,
    ).bind(...values),
    env.DB.prepare(`DELETE ${binRow} RETURNING id`).bind(...values),
    env.DB.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ${restoredId}`).bind(id, userId),
    selectTags(env, userId),
  ]);
  if (!results[3].results.length) return fail(404, 'not_found');
  return json({ recipe: toRecipe(results[4].results[0]), tags: results[5].results });
}

// The daily cron job: deletes for good what has been in the bin for 30 days.
export async function purgeDeleted(env, now = Date.now()) {
  const { meta } = await env.DB.prepare('DELETE FROM deleted_recipes WHERE deleted_at <= ?').bind(now - KEEP_MS).run();
  console.log(`Purged ${meta.changes} deleted recipes`);
}

// Routes /api/deleted-recipes and /api/deleted-recipes/:id/restore. Returns null when the
// path isn't one of them.
export function handleDeleted(request, env, path, userId) {
  const match = path.match(/^\/api\/deleted-recipes(?:\/(\d+)\/restore)?$/);
  if (!match) return null;
  if (!match[1] && request.method === 'GET') return listDeleted(env, userId);
  if (match[1] && request.method === 'POST') return restoreDeleted(env, userId, Number(match[1]));
  return fail(405, 'method_not_allowed');
}
