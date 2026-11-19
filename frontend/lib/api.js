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

// `body` is sent as JSON, except a Blob (a photo), which is sent as it is, with its type.
async function request(path, method = 'GET', body) {
  const isFile = body instanceof Blob;
  let headers = {};
  if (isFile) headers = { 'Content-Type': body.type };
  else if (body !== undefined) headers = { 'Content-Type': 'application/json' };
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: isFile || body === undefined ? body : JSON.stringify(body),
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

// The logged-in user ({ id, username, is_admin, defaultPublic, copyTags }), or null when
// nobody is logged in.
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

// Changes the logged-in user's username, password and/or defaults (`defaultPublic`: new
// recipes start public; `copyTags`: saving someone else's recipe copies its tags too);
// `changes` holds only what changes. Returns the updated user.
export async function updateAccount(changes) {
  return (await dataRequest('/api/auth/me', 'PUT', changes)).user;
}

// Admin only: everyone the admin can log in as, `[{ id, username }]`, A to Z.
export async function getUsers() {
  return (await dataRequest('/api/admin/users')).users;
}

// Admin only: this device is logged in as that user, with no password, until it logs out.
export async function impersonate(userId) {
  return (await dataRequest('/api/admin/impersonate', 'POST', { userId })).user;
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

// The backend's limits for calories (kcal) and protein (grams) per serving.
const NUTRITION_LIMITS = { calories: 10000, protein: 1000 };

// Like the backend: a whole number in range or null; undefined keeps the recipe's value.
function cleanNutrition(data, existing) {
  const nutrition = {};
  for (const [field, max] of Object.entries(NUTRITION_LIMITS)) {
    const value = data[field];
    if (value === undefined) {
      nutrition[field] = existing?.[field] ?? null;
    } else if (value === null || (Number.isInteger(value) && value >= 0 && value <= max)) {
      nutrition[field] = value;
    } else {
      throw new ApiError(400, 'invalid_nutrition');
    }
  }
  return nutrition;
}

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
// A recipe is { id, tagIds, favorite, public, link, fromPhoto, calories, protein, en: {name, ingredients[], steps[]}, he: {...} }.
// `link` is '' for a manual recipe and for one read from a photo (then `fromPhoto` is true).
// calories (kcal) and protein (grams) are per serving, null when not known.
// `public` means other users can see and copy it; a guest's recipes are never sent anywhere,
// so theirs is always true and means nothing.

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
// `data` is { en, he, calories, protein }; a calories or protein left out stays as it is.
export async function saveRecipe(id, data) {
  if (guest) {
    const fields = { en: cleanContent(data.en), he: cleanContent(data.he) };
    if (!fields.en.name && !fields.he.name) throw new ApiError(400, 'name_required');
    const existing = findRecipe(id);
    Object.assign(fields, cleanNutrition(data, existing));
    if (existing) Object.assign(existing, fields);
    else memory.recipes.push({ id: ++nextId, tagIds: [], link: '', fromPhoto: false, favorite: false, public: true, ...fields });
    return copy(existing ?? memory.recipes.at(-1));
  }
  const body = { en: data.en, he: data.he, calories: data.calories, protein: data.protein };
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

// Public (other users can see and copy it) or private. Returns the updated recipe.
export async function setRecipePublic(id, isPublic) {
  if (guest) {
    const recipe = findRecipe(id);
    if (!recipe) throw new ApiError(404, 'not_found');
    recipe.public = isPublic;
    return copy(recipe);
  }
  return (await dataRequest(`/api/recipes/${id}/public`, 'PUT', { public: isPublic })).recipe;
}

export async function deleteRecipe(id) {
  if (guest) {
    memory.recipes = memory.recipes.filter((r) => r.id !== id);
    dropUnusedTags();
    return;
  }
  await dataRequest(`/api/recipes/${id}`, 'DELETE');
}

// ---- Browse: other users' public recipes ----
// A browsed recipe is { id, owner, tags: [name], link, en, he }: who saved it and its tags
// by name. It needs an account, like everything that reads the database.

// A number for a new random order of the feed (the backend's order depends on it).
export const newBrowseSeed = () => 1 + Math.floor(Math.random() * 1000000);

// One page of the feed, in the order `seed` gives. `after` is the `next` of the page
// before (null for the first). Returns { recipes, next }, `next` null on the last page.
export async function getBrowse(seed, after = null) {
  if (guest) throw new ApiError(403, 'browse_needs_login');
  return dataRequest(`/api/browse?seed=${seed}${after ? `&after=${after}` : ''}`);
}

// Saves the user's own copy of a browsed recipe. Returns the new recipe.
export async function copyRecipe(id) {
  if (guest) throw new ApiError(403, 'browse_needs_login');
  return (await dataRequest(`/api/browse/${id}/copy`, 'POST', {})).recipe;
}

// ---- Imports from a video link ----
// An import is { id, status, stage, link, fromPhoto, title, error, retryable, recipeId, recipeName };
// a photo's has link '' and fromPhoto true.
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

// Sends one picture (a Blob with an image type, from preparePhoto in lib/photo.js) to be
// read in the background, always with the best model first. The same picture twice makes
// two recipes. Returns the new card.
export async function startPhotoImport(photo) {
  refuseGuest();
  return (await dataRequest('/api/imports/photo', 'POST', photo)).import;
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

// Estimates calories and protein per serving from one language's text ({ name,
// ingredients, steps }). `recipeId` is the recipe being edited, or null for one not saved
// yet. Nothing is saved: returns { calories, protein }.
export async function estimateNutrition(content, recipeId = null) {
  refuseGuest();
  const body = { content };
  if (recipeId !== null) body.recipeId = recipeId;
  return dataRequest('/api/nutrition', 'POST', body);
}
