// Tags and recipes. Every query is filtered by `userId`, the user the session works
// on (see getSessionUser), so nobody can read or change another user's data.

import { fail, json, readJson } from './http.js';

const MAX_TAG_NAME = 100;
const MAX_TAGS = 20; // per recipe
const MAX_RECIPE_NAME = 200;
const MAX_LINES = 200; // ingredients or steps per language
const MAX_LINE = 2000;

const LANGS = ['en', 'he'];

// A recipe as the frontend uses it: both languages side by side, `link` '' when manual.
function toRecipe(row) {
  const content = (lang) => ({
    name: row[`name_${lang}`],
    ingredients: JSON.parse(row[`ingredients_${lang}`]),
    steps: JSON.parse(row[`steps_${lang}`]),
  });
  return {
    id: row.id,
    tagIds: JSON.parse(row.tag_ids).sort((a, b) => a - b),
    favorite: row.is_favorite === 1,
    link: row.source_url ?? '',
    sourceModel: row.source_model,
    en: content('en'),
    he: content('he'),
  };
}

// tag_ids is a subquery, so the same list works in a SELECT and in RETURNING.
const RECIPE_COLUMNS = `id, is_favorite, source_url, source_model,
  name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he,
  (SELECT json_group_array(tag_id) FROM recipe_tags WHERE recipe_id = recipes.id) AS tag_ids`;

// Returns { value } for a valid tag name, or { error } with the code to send.
function readTagName(value) {
  if (typeof value !== 'string') return { error: 'invalid_request' };
  const name = value.trim();
  if (!name) return { error: 'name_required' };
  if (name.length > MAX_TAG_NAME) return { error: 'too_long' };
  return { value: name };
}

// Reads { tags: [name] }: trimmed names, with a name repeated in another case kept once
// (the same rule as the tags table, which compares ASCII letters without case).
function readTagNames(body) {
  if (!Array.isArray(body?.tags)) return { error: 'invalid_request' };
  const names = new Map();
  for (const tag of body.tags) {
    const name = readTagName(tag);
    if (name.error) return name;
    const key = name.value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (!names.has(key)) names.set(key, name.value);
  }
  if (names.size > MAX_TAGS) return { error: 'too_long' };
  return { value: [...names.values()] };
}

// Trims every line and drops blank ones, as the user meant "one per line".
function readLines(value) {
  if (!Array.isArray(value) || !value.every((line) => typeof line === 'string')) return null;
  return value.map((line) => line.trim()).filter(Boolean);
}

export function readContent(value) {
  if (typeof value?.name !== 'string') return { error: 'invalid_request' };
  const ingredients = readLines(value.ingredients);
  const steps = readLines(value.steps);
  if (!ingredients || !steps) return { error: 'invalid_request' };
  const name = value.name.trim();
  const tooLong =
    name.length > MAX_RECIPE_NAME ||
    ingredients.length > MAX_LINES ||
    steps.length > MAX_LINES ||
    [...ingredients, ...steps].some((line) => line.length > MAX_LINE);
  if (tooLong) return { error: 'too_long' };
  return { value: { name, ingredients, steps } };
}

// Reads { en, he }. Tags are not part of it: they have their own endpoint.
async function readRecipe(request) {
  const body = await readJson(request);
  if (!body) return { error: 'invalid_request' };

  const recipe = {};
  for (const lang of LANGS) {
    const content = readContent(body[lang]);
    if (content.error) return content;
    recipe[lang] = content.value;
  }
  if (!recipe.en.name && !recipe.he.name) return { error: 'name_required' };
  return { value: recipe };
}

// The bound values for the content columns, in RECIPE_COLUMNS order (en, then he).
export const contentValues = (recipe) =>
  LANGS.flatMap((lang) => [
    recipe[lang].name,
    JSON.stringify(recipe[lang].ingredients),
    JSON.stringify(recipe[lang].steps),
  ]);

// ---- Tags ----

const selectTags = (env, userId) =>
  env.DB.prepare('SELECT id, name FROM tags WHERE user_id = ? ORDER BY id').bind(userId);

// A tag exists only while a recipe has it, so this runs with every change that can leave
// one unused.
const deleteUnusedTags = (env, userId) =>
  env.DB.prepare(
    'DELETE FROM tags WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM recipe_tags WHERE tag_id = tags.id)',
  ).bind(userId);

async function listTags(env, userId) {
  const { results } = await selectTags(env, userId).all();
  return json({ tags: results });
}

// Renaming to another tag's name is refused rather than merging the two by surprise.
async function renameTag(request, env, userId, id) {
  const name = readTagName((await readJson(request))?.name);
  if (name.error) return fail(400, name.error);
  const tag = await env.DB.prepare(
    `UPDATE tags SET name = ?1 WHERE id = ?2 AND user_id = ?3
       AND NOT EXISTS (SELECT 1 FROM tags AS other WHERE other.user_id = ?3 AND other.name = ?1 AND other.id <> ?2)
     RETURNING id, name`,
  )
    .bind(name.value, id, userId)
    .first();
  if (tag) return json({ tag });
  const exists = await env.DB.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?').bind(id, userId).first();
  return exists ? fail(409, 'tag_exists') : fail(404, 'not_found');
}

// Sets the recipe's tags to exactly the given names, in one batch: a name the user
// already has (in any case) is that tag, a new name becomes a new tag, and a tag left on
// no recipe is deleted. Answers with the recipe and the user's tags after the change.
async function setRecipeTags(request, env, userId, id) {
  const names = readTagNames(await readJson(request));
  if (names.error) return fail(400, names.error);
  const owned = await env.DB.prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!owned) return fail(404, 'not_found');

  const results = await env.DB.batch([
    ...names.value.map((name) =>
      env.DB.prepare('INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(userId, name),
    ),
    env.DB.prepare(
      'DELETE FROM recipe_tags WHERE recipe_id IN (SELECT id FROM recipes WHERE id = ? AND user_id = ?)',
    ).bind(id, userId),
    ...names.value.map((name) =>
      env.DB.prepare(
        `INSERT INTO recipe_tags (recipe_id, tag_id)
         SELECT recipes.id, tags.id FROM recipes, tags
         WHERE recipes.id = ?1 AND recipes.user_id = ?2 AND tags.user_id = ?2 AND tags.name = ?3`,
      ).bind(id, userId, name),
    ),
    deleteUnusedTags(env, userId),
    env.DB.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ? AND user_id = ?`).bind(id, userId),
    selectTags(env, userId),
  ]);
  const [recipe] = results.at(-2).results;
  if (!recipe) return fail(404, 'not_found'); // deleted while this ran
  return json({ recipe: toRecipe(recipe), tags: results.at(-1).results });
}

// ---- Recipes ----

async function listRecipes(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT ${RECIPE_COLUMNS} FROM recipes WHERE user_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all();
  return json({ recipes: results.map(toRecipe) });
}

async function getRecipe(env, userId, id) {
  const row = await env.DB.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first();
  return row ? json({ recipe: toRecipe(row) }) : fail(404, 'not_found');
}

async function createRecipe(request, env, userId) {
  const recipe = await readRecipe(request);
  if (recipe.error) return fail(400, recipe.error);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO recipes (user_id,
       name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${RECIPE_COLUMNS}`,
  )
    .bind(userId, ...contentValues(recipe.value), now, now)
    .first();
  return json({ recipe: toRecipe(row) }, 201);
}

// Replaces the text only: the tags, favorite and link stay. Editing a language the LLM
// filled in makes it the user's own text, so its machine-translated label is cleared
// (see schema.sql).
async function updateRecipe(request, env, userId, id) {
  const recipe = await readRecipe(request);
  if (recipe.error) return fail(400, recipe.error);
  const row = await env.DB.prepare(
    `UPDATE recipes SET
       machine_translated_lang = CASE
         WHEN machine_translated_lang = 'en' AND (name_en <> ?2 OR ingredients_en <> ?3 OR steps_en <> ?4) THEN NULL
         WHEN machine_translated_lang = 'he' AND (name_he <> ?5 OR ingredients_he <> ?6 OR steps_he <> ?7) THEN NULL
         ELSE machine_translated_lang END,
       name_en = ?2, ingredients_en = ?3, steps_en = ?4,
       name_he = ?5, ingredients_he = ?6, steps_he = ?7,
       updated_at = ?8
     WHERE id = ?9 AND user_id = ?1
     RETURNING ${RECIPE_COLUMNS}`,
  )
    .bind(userId, ...contentValues(recipe.value), Date.now(), id)
    .first();
  return row ? json({ recipe: toRecipe(row) }) : fail(404, 'not_found');
}

// Sets (not toggles) the flag, so a repeated tap or retried request can't flip it back.
async function setFavorite(request, env, userId, id) {
  const body = await readJson(request);
  if (typeof body?.favorite !== 'boolean') return fail(400, 'invalid_request');
  const row = await env.DB.prepare(
    `UPDATE recipes SET is_favorite = ? WHERE id = ? AND user_id = ? RETURNING ${RECIPE_COLUMNS}`,
  )
    .bind(body.favorite ? 1 : 0, id, userId)
    .first();
  return row ? json({ recipe: toRecipe(row) }) : fail(404, 'not_found');
}

// Its tags go with it, and a tag that was only on this recipe is deleted too.
async function deleteRecipe(env, userId, id) {
  const [deleted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ? RETURNING id').bind(id, userId),
    deleteUnusedTags(env, userId),
  ]);
  return deleted.results.length ? json({ ok: true }) : fail(404, 'not_found');
}

// Routes /api/tags[/:id] and /api/recipes[/:id[/favorite|/tags]]. Returns null when the
// path isn't one of them.
export function handleData(request, env, path, userId) {
  const match = path.match(/^\/api\/(tags|recipes)(?:\/(\d+)(?:\/(favorite|tags))?)?$/);
  if (!match || (match[1] === 'tags' && match[3])) return null;
  const [, kind, idText, part] = match;
  const id = idText === undefined ? null : Number(idText);
  const method = request.method;

  if (kind === 'tags') {
    if (id === null && method === 'GET') return listTags(env, userId);
    if (id !== null && method === 'PUT') return renameTag(request, env, userId, id);
  } else if (part === 'favorite') {
    if (method === 'PUT') return setFavorite(request, env, userId, id);
  } else if (part === 'tags') {
    if (method === 'PUT') return setRecipeTags(request, env, userId, id);
  } else {
    if (id === null && method === 'GET') return listRecipes(env, userId);
    if (id === null && method === 'POST') return createRecipe(request, env, userId);
    if (id !== null && method === 'GET') return getRecipe(env, userId, id);
    if (id !== null && method === 'PUT') return updateRecipe(request, env, userId, id);
    if (id !== null && method === 'DELETE') return deleteRecipe(env, userId, id);
  }
  return fail(405, 'method_not_allowed');
}
