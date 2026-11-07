// Folders and recipes. Every query is filtered by `userId`, the user the session works
// on (see getSessionUser), so nobody can read or change another user's data.

import { fail, json, readJson } from './http.js';

const MAX_FOLDER_NAME = 100;
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
    folderId: row.folder_id,
    favorite: row.is_favorite === 1,
    link: row.source_url ?? '',
    en: content('en'),
    he: content('he'),
  };
}

const RECIPE_COLUMNS = `id, folder_id, is_favorite, source_url,
  name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he`;

// Returns { value } for a valid folder name, or { error } with the code to send.
function readFolderName(body) {
  if (typeof body?.name !== 'string') return { error: 'invalid_request' };
  const name = body.name.trim();
  if (!name) return { error: 'name_required' };
  if (name.length > MAX_FOLDER_NAME) return { error: 'too_long' };
  return { value: name };
}

// Trims every line and drops blank ones, as the user meant "one per line".
function readLines(value) {
  if (!Array.isArray(value) || !value.every((line) => typeof line === 'string')) return null;
  return value.map((line) => line.trim()).filter(Boolean);
}

function readContent(value) {
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

// Reads { folderId, en, he } and checks the folder belongs to the user.
async function readRecipe(request, env, userId) {
  const body = await readJson(request);
  if (!body) return { error: 'invalid_request' };

  const recipe = { folderId: body.folderId ?? null };
  for (const lang of LANGS) {
    const content = readContent(body[lang]);
    if (content.error) return content;
    recipe[lang] = content.value;
  }
  if (!recipe.en.name && !recipe.he.name) return { error: 'name_required' };

  if (recipe.folderId !== null) {
    if (!Number.isInteger(recipe.folderId)) return { error: 'invalid_request' };
    const folder = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
      .bind(recipe.folderId, userId)
      .first();
    if (!folder) return { error: 'folder_not_found' };
  }
  return { value: recipe };
}

// The bound values for the content columns, in RECIPE_COLUMNS order (en, then he).
const contentValues = (recipe) =>
  LANGS.flatMap((lang) => [
    recipe[lang].name,
    JSON.stringify(recipe[lang].ingredients),
    JSON.stringify(recipe[lang].steps),
  ]);

// ---- Folders ----

async function listFolders(env, userId) {
  const { results } = await env.DB.prepare('SELECT id, name FROM folders WHERE user_id = ? ORDER BY id')
    .bind(userId)
    .all();
  return json({ folders: results });
}

async function createFolder(request, env, userId) {
  const name = readFolderName(await readJson(request));
  if (name.error) return fail(400, name.error);
  const folder = await env.DB.prepare('INSERT INTO folders (user_id, name) VALUES (?, ?) RETURNING id, name')
    .bind(userId, name.value)
    .first();
  return json({ folder }, 201);
}

async function renameFolder(request, env, userId, id) {
  const name = readFolderName(await readJson(request));
  if (name.error) return fail(400, name.error);
  const folder = await env.DB.prepare(
    'UPDATE folders SET name = ? WHERE id = ? AND user_id = ? RETURNING id, name',
  )
    .bind(name.value, id, userId)
    .first();
  return folder ? json({ folder }) : fail(404, 'not_found');
}

// Only an empty folder can be deleted, so recipes are never lost or moved by accident.
// The NOT EXISTS keeps that true even if a recipe is added at the same moment.
async function deleteFolder(env, userId, id) {
  const deleted = await env.DB.prepare(
    `DELETE FROM folders WHERE id = ? AND user_id = ?
       AND NOT EXISTS (SELECT 1 FROM recipes WHERE folder_id = folders.id)
     RETURNING id`,
  )
    .bind(id, userId)
    .first();
  if (deleted) return json({ ok: true });
  const exists = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  return exists ? fail(409, 'folder_not_empty') : fail(404, 'not_found');
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
  const recipe = await readRecipe(request, env, userId);
  if (recipe.error) return fail(400, recipe.error);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO recipes (user_id, folder_id,
       name_en, ingredients_en, steps_en, name_he, ingredients_he, steps_he, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${RECIPE_COLUMNS}`,
  )
    .bind(userId, recipe.value.folderId, ...contentValues(recipe.value), now, now)
    .first();
  return json({ recipe: toRecipe(row) }, 201);
}

// Editing a language the LLM filled in makes it the user's own text, so its
// machine-translated label is cleared (see schema.sql).
async function updateRecipe(request, env, userId, id) {
  const recipe = await readRecipe(request, env, userId);
  if (recipe.error) return fail(400, recipe.error);
  const row = await env.DB.prepare(
    `UPDATE recipes SET
       machine_translated_lang = CASE
         WHEN machine_translated_lang = 'en' AND (name_en <> ?3 OR ingredients_en <> ?4 OR steps_en <> ?5) THEN NULL
         WHEN machine_translated_lang = 'he' AND (name_he <> ?6 OR ingredients_he <> ?7 OR steps_he <> ?8) THEN NULL
         ELSE machine_translated_lang END,
       folder_id = ?2,
       name_en = ?3, ingredients_en = ?4, steps_en = ?5,
       name_he = ?6, ingredients_he = ?7, steps_he = ?8,
       updated_at = ?9
     WHERE id = ?10 AND user_id = ?1
     RETURNING ${RECIPE_COLUMNS}`,
  )
    .bind(userId, recipe.value.folderId, ...contentValues(recipe.value), Date.now(), id)
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

async function deleteRecipe(env, userId, id) {
  const deleted = await env.DB.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ? RETURNING id')
    .bind(id, userId)
    .first();
  return deleted ? json({ ok: true }) : fail(404, 'not_found');
}

// Routes /api/folders[/:id] and /api/recipes[/:id[/favorite]]. Returns null when the
// path isn't one of them.
export function handleData(request, env, path, userId) {
  const match = path.match(/^\/api\/(folders|recipes)(?:\/(\d+)(\/favorite)?)?$/);
  if (!match || (match[1] === 'folders' && match[3])) return null;
  const [, kind, idText, favorite] = match;
  const id = idText === undefined ? null : Number(idText);
  const method = request.method;

  if (kind === 'folders') {
    if (id === null && method === 'GET') return listFolders(env, userId);
    if (id === null && method === 'POST') return createFolder(request, env, userId);
    if (id !== null && method === 'PUT') return renameFolder(request, env, userId, id);
    if (id !== null && method === 'DELETE') return deleteFolder(env, userId, id);
  }
  if (kind === 'recipes' && favorite) {
    if (method === 'PUT') return setFavorite(request, env, userId, id);
  } else if (kind === 'recipes') {
    if (id === null && method === 'GET') return listRecipes(env, userId);
    if (id === null && method === 'POST') return createRecipe(request, env, userId);
    if (id !== null && method === 'GET') return getRecipe(env, userId, id);
    if (id !== null && method === 'PUT') return updateRecipe(request, env, userId, id);
    if (id !== null && method === 'DELETE') return deleteRecipe(env, userId, id);
  }
  return fail(405, 'method_not_allowed');
}
