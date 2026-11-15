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

// "The user already has it": they copied it, or they have a recipe from the same link.
const SAVED = `EXISTS (SELECT 1 FROM recipes AS mine WHERE mine.user_id = ?1
  AND (mine.copied_from = r.id OR (r.source_url IS NOT NULL AND mine.source_url = r.source_url)))`;

// What Browse may show the user (?1): other users' public recipes they don't have yet. A
// copy stays out while the recipe it was copied from is in Browse (or is the user's own),
// so one recipe doesn't show once per person who saved it.
const VISIBLE = `r.user_id <> ?1 AND r.is_public = 1 AND NOT ${SAVED}
  AND NOT EXISTS (SELECT 1 FROM recipes AS original
    WHERE original.id = r.copied_from AND (original.is_public = 1 OR original.user_id = ?1))`;

const TAG_NAMES = `(SELECT json_group_array(tags.name) FROM recipe_tags
  JOIN tags ON tags.id = recipe_tags.tag_id WHERE recipe_tags.recipe_id = r.id)`;

// A recipe as Browse shows it: who saved it and its tags by name (tag ids mean nothing to
// another user), and none of the owner's own marks.
function toBrowseRecipe(row) {
  const { id, link, en, he } = toRecipe({ ...row, tag_ids: '[]' });
  return { id, owner: row.owner, tags: JSON.parse(row.tag_names), link, en, he };
}

// A whole number from the query string, or null.
function readInt(text, min, max) {
  if (!/^\d{1,15}$/.test(text ?? '')) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

// One page. `after` is the `next` of the page before ("<key>.<id>"): pages continue from
// the last recipe shown rather than from a count, so a recipe saved or deleted meanwhile
// doesn't make the next page skip or repeat one.
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
    `SELECT r.id, r.is_favorite, r.is_public, r.source_url, r.source_model,
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

// Saves the user's own copy of another user's public recipe: the same text and link,
// public or private as the user's default says, with no favorite. Its tags come too when
// the user's "copy tags" default is on, as the user's own tags (found by name, or made).
// Everything is one batch, and each statement checks again that the recipe may be copied
// and isn't saved yet, so a double tap makes one copy.
async function copyRecipe(env, userId, id) {
  const source = await env.DB.prepare(
    `SELECT ${SAVED} AS saved, ${TAG_NAMES} AS tag_names,
            (SELECT copy_tags FROM users WHERE id = ?1) AS copy_tags
       FROM recipes AS r WHERE r.id = ?2 AND r.user_id <> ?1 AND r.is_public = 1`,
  )
    .bind(userId, id)
    .first();
  if (!source) return fail(404, 'not_found');
  if (source.saved) return fail(409, 'already_saved');

  const tagNames = source.copy_tags === 1 ? JSON.parse(source.tag_names) : [];
  const copyId = '(SELECT id FROM recipes WHERE user_id = ?1 AND copied_from = ?2 ORDER BY id DESC LIMIT 1)';
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recipes (user_id, is_public, copied_from, platform, source_url, source_model,
         name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
         machine_translated_lang, created_at, updated_at)
       SELECT ?1, (SELECT default_public FROM users WHERE id = ?1), r.id, r.platform, r.source_url, r.source_model,
         r.name_en, r.ingredients_en, r.steps_en, r.name_he, r.ingredients_he, r.steps_he,
         r.machine_translated_lang, ?3, ?3
       FROM recipes AS r
       WHERE r.id = ?2 AND r.user_id <> ?1 AND r.is_public = 1 AND NOT ${SAVED}`,
    ).bind(userId, id, now),
    ...tagNames.map((name) =>
      env.DB.prepare(
        `INSERT INTO tags (user_id, name) SELECT ?1, ?3 WHERE ${copyId} IS NOT NULL ON CONFLICT DO NOTHING`,
      ).bind(userId, id, name),
    ),
    ...tagNames.map((name) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id)
         SELECT ${copyId}, tags.id FROM tags
         WHERE tags.user_id = ?1 AND tags.name = ?3 AND ${copyId} IS NOT NULL`,
      ).bind(userId, id, name),
    ),
    deleteUnusedTags(env, userId),
    env.DB.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ${copyId}`).bind(userId, id),
  ]);
  const [copy] = results.at(-1).results;
  // Made private or deleted in the instant between the two requests.
  if (!copy) return fail(404, 'not_found');
  return json({ recipe: toRecipe(copy) }, 201);
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
