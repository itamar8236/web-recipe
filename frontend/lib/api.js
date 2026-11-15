// The only data layer for the UI. A logged-in user's tags and recipes come from the
// backend; a guest's live only in memory here (never sent anywhere) and are gone on
// reload. Both modes have the same functions and errors, so components never check.

// An error from the backend. `code` is its machine-readable `error` value.
export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Called when a data request finds the user logged out (the session is gone),
// so the app can show the login screen.
let onLoggedOut = () => {};
export function setLoggedOutHandler(handler) {
  onLoggedOut = handler;
}

async function request(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'server_error');
  return data;
}

// A request for the user's data: a 401 here means the session is gone.
async function dataRequest(path, method, body) {
  try {
    return await request(path, method, body);
  } catch (error) {
    if (error.status === 401) onLoggedOut();
    throw error;
  }
}

// The logged-in user ({ id, username, is_admin }), or null when nobody is logged in.
export async function getMe() {
  try {
    return (await request('/api/auth/me')).user;
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

export async function login(username, password) {
  return (await request('/api/auth/login', 'POST', { username, password })).user;
}

export async function register(username, password) {
  return (await request('/api/auth/register', 'POST', { username, password })).user;
}

// Changes the logged-in user's username and/or password; `changes` holds only what
// changes. Returns the updated user.
export async function updateAccount(changes) {
  return (await dataRequest('/api/auth/me', 'PUT', changes)).user;
}

export async function logout() {
  await request('/api/auth/logout', 'POST');
}

// ---- Guest store (in memory) ----

let guest = false;
let nextId = 0;
let memory = { tags: [], recipes: [] };

// Called on every change of who uses the app. A guest starts from an empty app, and one
// guest's data never shows for the next person.
export function setGuestMode(on) {
  guest = on;
  memory = { tags: [], recipes: [] };
}

const copy = (value) => structuredClone(value);
const findRecipe = (id) => memory.recipes.find((r) => r.id === id);

function cleanContent(content) {
  const lines = (list) => list.map((line) => line.trim()).filter(Boolean);
  return { name: content.name.trim(), ingredients: lines(content.ingredients), steps: lines(content.steps) };
}

// The same checks the backend makes, so a guest sees the same messages.
function tagName(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new ApiError(400, 'name_required');
  return trimmed;
}

// The backend compares tag names without case for ASCII letters only (SQLite's NOCASE).
const tagKey = (name) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// A tag exists only while a recipe has it.
function dropUnusedTags() {
  memory.tags = memory.tags.filter((tag) => memory.recipes.some((r) => r.tagIds.includes(tag.id)));
}

// ---- Tags ----
// A tag is { id, name }. There is no "create" or "delete": a tag appears when a recipe
// gets it (setRecipeTags) and is gone when no recipe has it.

export async function getTags() {
  if (guest) return copy(memory.tags);
  return (await dataRequest('/api/tags')).tags;
}

export async function renameTag(id, name) {
  if (guest) {
    const tag = memory.tags.find((t) => t.id === id);
    if (!tag) throw new ApiError(404, 'not_found');
    const newName = tagName(name);
    if (memory.tags.some((t) => t.id !== id && tagKey(t.name) === tagKey(newName))) throw new ApiError(409, 'tag_exists');
    tag.name = newName;
    return copy(tag);
  }
  return (await dataRequest(`/api/tags/${id}`, 'PUT', { name })).tag;
}

// Sets the recipe's tags to exactly `names`: a name the user already has (in any case) is
// that tag, and a new name becomes a new tag. Returns { recipe, tags }, the recipe and
// all the user's tags after the change.
export async function setRecipeTags(id, names) {
  if (guest) {
    const recipe = findRecipe(id);
    if (!recipe) throw new ApiError(404, 'not_found');
    const tagIds = new Set();
    for (const name of names.map(tagName)) {
      let tag = memory.tags.find((t) => tagKey(t.name) === tagKey(name));
      if (!tag) {
        tag = { id: ++nextId, name };
        memory.tags.push(tag);
      }
      tagIds.add(tag.id);
    }
    recipe.tagIds = [...tagIds].sort((a, b) => a - b);
    dropUnusedTags();
    return copy({ recipe, tags: memory.tags });
  }
  return dataRequest(`/api/recipes/${id}/tags`, 'PUT', { tags: names });
}

// ---- Recipes ----
// A recipe is { id, tagIds, favorite, link, en: {name, ingredients[], steps[]}, he: {...} }.

export async function getRecipes() {
  if (guest) return copy(memory.recipes);
  return (await dataRequest('/api/recipes')).recipes;
}

// The recipe, or null if it doesn't exist (or isn't this user's).
export async function getRecipe(id) {
  if (guest) {
    const recipe = findRecipe(id);
    return recipe ? copy(recipe) : null;
  }
  try {
    return (await dataRequest(`/api/recipes/${id}`)).recipe;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// Creates the recipe when `id` is null (with no tags), otherwise replaces its text.
// `data` is { en, he }.
export async function saveRecipe(id, data) {
  if (guest) {
    const fields = { en: cleanContent(data.en), he: cleanContent(data.he) };
    if (!fields.en.name && !fields.he.name) throw new ApiError(400, 'name_required');
    const existing = findRecipe(id);
    if (existing) Object.assign(existing, fields);
    else memory.recipes.push({ id: ++nextId, tagIds: [], link: '', favorite: false, ...fields });
    return copy(existing ?? memory.recipes.at(-1));
  }
  const body = { en: data.en, he: data.he };
  return id === null
    ? (await dataRequest('/api/recipes', 'POST', body)).recipe
    : (await dataRequest(`/api/recipes/${id}`, 'PUT', body)).recipe;
}

// Returns the updated recipe.
export async function setFavorite(id, favorite) {
  if (guest) {
    const recipe = findRecipe(id);
    if (!recipe) throw new ApiError(404, 'not_found');
    recipe.favorite = favorite;
    return copy(recipe);
  }
  return (await dataRequest(`/api/recipes/${id}/favorite`, 'PUT', { favorite })).recipe;
}

export async function deleteRecipe(id) {
  if (guest) {
    memory.recipes = memory.recipes.filter((r) => r.id !== id);
    dropUnusedTags();
    return;
  }
  await dataRequest(`/api/recipes/${id}`, 'DELETE');
}

// ---- Imports from a video link ----
// An import is { id, status, stage, link, title, error, retryable, recipeId, recipeName }.
// Importing needs an account, so a guest is refused here and never reaches the backend.

function refuseGuest() {
  if (guest) throw new ApiError(403, 'import_needs_login');
}

// Returns { imports, models }.
export async function getImports() {
  refuseGuest();
  return dataRequest('/api/imports');
}

// Only the link is sent: the backend works out which site it is, and which model reads it.
export async function startImport(url) {
  refuseGuest();
  return (await dataRequest('/api/imports', 'POST', { url })).import;
}

// Returns the new card: a Retry is a new import, and the failed card goes away.
export async function retryImport(id) {
  refuseGuest();
  return (await dataRequest(`/api/imports/${id}/retry`, 'POST', {})).import;
}

export async function dismissImport(id) {
  refuseGuest();
  await dataRequest(`/api/imports/${id}`, 'DELETE');
}

// Scans an imported recipe's video again, replacing its text when done. `useBest` asks for
// the best model, the one model choice a user has; the backend still goes on with the
// usual models by itself when that one can't be used.
export async function rerunRecipe(id, useBest = false) {
  refuseGuest();
  return (await dataRequest(`/api/recipes/${id}/rerun`, 'POST', useBest ? { model: 'best' } : {})).import;
}

// Translates one language's text ({ name, ingredients, steps }) from `from` ('en' or 'he')
// into the other. `recipeId` is the recipe being edited, or null for one not saved yet.
// Nothing is saved: returns the translated content.
export async function translateRecipe(from, content, recipeId = null) {
  refuseGuest();
  const body = { from, content };
  if (recipeId !== null) body.recipeId = recipeId;
  return (await dataRequest('/api/translate', 'POST', body)).content;
}
