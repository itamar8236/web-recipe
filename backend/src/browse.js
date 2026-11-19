// Browse: the one place a user reads other users' recipes. Only public ones, never the
// user's own, and nothing here changes another user's data: "Save" writes a copy that
// belongs to the user who tapped it.

import { RECIPE_COLUMNS, deleteUnusedTags, toRecipe } from './data.js';
import { fail, json } from './http.js';

const PAGE_SIZE = 10;

// The feed's order is a shuffle that depends on `seed`, so every page of one visit comes
// from the same order and a new visit (a new seed) gets a new one. The key is the cube of
// (id + seed) modulo a prime: plain integer maths SQLite can sort by, with neighbouring
// ids landing far apart. Two recipes may share a key, so the id breaks the tie.
const PRIME = 1000003;
const ORDER_KEY = `((((r.id + ?2) * (r.id + ?2)) % ${PRIME}) * (r.id + ?2)) % ${PRIME}`;

// What Browse may show the user (?1): every public recipe of another user. A copy is a
// plain recipe with no link to its original, so a recipe the user already saved shows
// again, and so does another user's public copy of it (the owner's choice: simple).
const VISIBLE = 'r.user_id <> ?1 AND r.is_public = 1';

const TAG_NAMES = `(SELECT json_group_array(tags.name) FROM recipe_tags
  JOIN tags ON tags.id = recipe_tags.tag_id WHERE recipe_tags.recipe_id = r.id)`;

// A recipe as Browse shows it: who saved it and its tags by name (tag ids mean nothing to
// another user), and none of the owner's own marks.
function toBrowseRecipe(row) {
  const { id, link, fromPhoto, en, he } = toRecipe({ ...row, tag_ids: '[]' });
  return { id, owner: row.owner, tags: JSON.parse(row.tag_names), link, fromPhoto, en, he };
}

// A whole number from the query string, or null.
function readInt(text, min, max) {
  if (!/^\d{1,15}$/.test(text ?? '')) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

// One page. `after` is the `next` of the page before ("<key>.<id>"): pages continue from
// the last recipe shown rather than from a count, so a recipe deleted or made private
// meanwhile doesn't make the next page skip or repeat one.
async function listBrowse(request, env, userId) {
  const params = new URL(request.url).searchParams;
  const seed = readInt(params.get('seed'), 1, PRIME - 1);
  if (seed === null) return fail(400, 'invalid_request');
  let afterKey = -1;
  let afterId = 0;
  if (params.has('after')) {
    const [key, id] = params.get('after').split('.');
    afterKey = readInt(key, 0, PRIME);
    afterId = readInt(id, 0, Number.MAX_SAFE_INTEGER);
    if (afterKey === null || afterId === null) return fail(400, 'invalid_request');
  }

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.is_favorite, r.is_public, r.source_url, r.source_model, r.calories, r.protein,
            r.name_en, r.ingredients_en, r.steps_en, r.name_he, r.ingredients_he, r.steps_he,
            users.username AS owner, ${TAG_NAMES} AS tag_names, ${ORDER_KEY} AS order_key
       FROM recipes AS r JOIN users ON users.id = r.user_id
      WHERE ${VISIBLE}
        AND (${ORDER_KEY} > ?3 OR (${ORDER_KEY} = ?3 AND r.id > ?4))
      ORDER BY order_key, r.id
      LIMIT ?5`,
  )
    .bind(userId, seed, afterKey, afterId, PAGE_SIZE + 1)
    .all();

  const page = results.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return json({
    recipes: page.map(toBrowseRecipe),
    next: results.length > PAGE_SIZE ? `${last.order_key}.${last.id}` : null,
  });
}

// Saves the user's own copy of another user's public recipe: the same text, link,
// calories and protein,
// public or private as the user's default says, with no favorite. Its tags come too when
// the user's "copy tags" default is on, as the user's own tags (found by name, or made).
// Saving the same recipe again makes another copy.
async function copyRecipe(env, userId, id) {
  const copy = await env.DB.prepare(
    `INSERT INTO recipes (user_id, is_public, platform, source_url, source_model,
       name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
       machine_translated_lang, calories, protein, created_at, updated_at)
     SELECT ?1, (SELECT default_public FROM users WHERE id = ?1), r.platform, r.source_url, r.source_model,
       r.name_en, r.ingredients_en, r.steps_en, r.name_he, r.ingredients_he, r.steps_he,
       r.machine_translated_lang, r.calories, r.protein, ?3, ?3
     FROM recipes AS r
     WHERE r.id = ?2 AND ${VISIBLE}
     RETURNING id`,
  )
    .bind(userId, id, Date.now())
    .first();
  if (!copy) return fail(404, 'not_found');

  // The tags are a second step. If it fails the copy is already saved, without tags, and
  // the user can add them on its page.
  const source = await env.DB.prepare(
    `SELECT ${TAG_NAMES} AS tag_names, (SELECT copy_tags FROM users WHERE id = ?1) AS copy_tags
       FROM recipes AS r WHERE r.id = ?2`,
  )
    .bind(userId, id)
    .first();
  const tagNames = source?.copy_tags === 1 ? JSON.parse(source.tag_names) : [];
  const results = await env.DB.batch([
    ...tagNames.map((name) =>
      env.DB.prepare('INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(userId, name),
    ),
    ...tagNames.map((name) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id)
         SELECT recipes.id, tags.id FROM recipes, tags
         WHERE recipes.id = ?1 AND recipes.user_id = ?2 AND tags.user_id = ?2 AND tags.name = ?3`,
      ).bind(copy.id, userId, name),
    ),
    deleteUnusedTags(env, userId),
    env.DB.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ? AND user_id = ?`).bind(copy.id, userId),
  ]);
  const [saved] = results.at(-1).results;
  if (!saved) return fail(404, 'not_found'); // deleted while this ran
  return json({ recipe: toRecipe(saved) }, 201);
}

// Routes /api/browse and /api/browse/:id/copy. Returns null when the path isn't one of them.
export function handleBrowse(request, env, path, userId) {
  const match = path.match(/^\/api\/browse(?:\/(\d+)\/copy)?$/);
  if (!match) return null;
  if (match[1] === undefined) {
    if (request.method === 'GET') return listBrowse(request, env, userId);
  } else if (request.method === 'POST') {
    return copyRecipe(env, userId, Number(match[1]));
  }
  return fail(405, 'method_not_allowed');
}
