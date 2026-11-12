// The only data layer for the UI. A logged-in user's folders and recipes come from the
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

// Called when a data request finds the user logged out (e.g. the admin deleted them),
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
let memory = { folders: [], recipes: [] };

// Called on every change of who uses the app. A guest starts from an empty app, and one
// guest's data never shows for the next person.
export function setGuestMode(on) {
  guest = on;
  memory = { folders: [], recipes: [] };
}

const copy = (value) => structuredClone(value);
const findRecipe = (id) => memory.recipes.find((r) => r.id === id);

function cleanContent(content) {
  const lines = (list) => list.map((line) => line.trim()).filter(Boolean);
  return { name: content.name.trim(), ingredients: lines(content.ingredients), steps: lines(content.steps) };
}

// The same checks the backend makes, so a guest sees the same messages.
function folderName(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new ApiError(400, 'name_required');
  return trimmed;
}

// ---- Folders ----

export async function getFolders() {
  if (guest) return copy(memory.folders);
  return (await dataRequest('/api/folders')).folders;
}

export async function createFolder(name) {
  if (guest) {
    const folder = { id: ++nextId, name: folderName(name) };
    memory.folders.push(folder);
    return copy(folder);
  }
  return (await dataRequest('/api/folders', 'POST', { name })).folder;
}

export async function renameFolder(id, name) {
  if (guest) {
    const folder = memory.folders.find((f) => f.id === id);
    if (!folder) throw new ApiError(404, 'not_found');
    folder.name = folderName(name);
    return copy(folder);
  }
  return (await dataRequest(`/api/folders/${id}`, 'PUT', { name })).folder;
}

// Only empty folders can be deleted, so recipes are never lost or moved by accident.
export async function deleteFolder(id) {
  if (guest) {
    if (memory.recipes.some((r) => r.folderId === id)) throw new ApiError(409, 'folder_not_empty');
    memory.folders = memory.folders.filter((f) => f.id !== id);
    return;
  }
  await dataRequest(`/api/folders/${id}`, 'DELETE');
}

// ---- Recipes ----
// A recipe is { id, folderId, favorite, link, en: {name, ingredients[], steps[]}, he: {...} }.

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

// Creates the recipe when `id` is null, otherwise replaces its text and folder.
// `data` is { folderId, en, he }.
export async function saveRecipe(id, data) {
  if (guest) {
    const fields = { folderId: data.folderId ?? null, en: cleanContent(data.en), he: cleanContent(data.he) };
    if (!fields.en.name && !fields.he.name) throw new ApiError(400, 'name_required');
    const existing = findRecipe(id);
    if (existing) Object.assign(existing, fields);
    else memory.recipes.push({ id: ++nextId, link: '', favorite: false, ...fields });
    return copy(existing ?? memory.recipes.at(-1));
  }
  const body = { folderId: data.folderId ?? null, en: data.en, he: data.he };
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

// Only the link is sent: the backend works out which site it is.
// `model` is 'best' or 'basic'; `useBasicModel` approves falling back to basic when best is out.
export async function startImport(url, useBasicModel = false, model = 'best') {
  refuseGuest();
  const body = { url };
  if (useBasicModel) body.useBasicModel = true;
  if (model === 'basic') body.model = 'basic';
  return (await dataRequest('/api/imports', 'POST', body)).import;
}

export async function retryImport(id, useBasicModel = false) {
  refuseGuest();
  return (await dataRequest(`/api/imports/${id}/retry`, 'POST', useBasicModel ? { useBasicModel } : {})).import;
}

export async function dismissImport(id) {
  refuseGuest();
  await dataRequest(`/api/imports/${id}`, 'DELETE');
}

// Scans an imported recipe's video again, replacing its text when done. Same model choice
// as startImport.
export async function rerunRecipe(id, useBasicModel = false, model = 'best') {
  refuseGuest();
  const body = {};
  if (useBasicModel) body.useBasicModel = true;
  if (model === 'basic') body.model = 'basic';
  return (await dataRequest(`/api/recipes/${id}/rerun`, 'POST', body)).import;
}

// Translates one language's text ({ name, ingredients, steps }) from `from` ('en' or 'he')
// into the other, with `model` 'best' or 'basic'. Nothing is saved: returns the text.
export async function translateRecipe(from, content, model) {
  refuseGuest();
  return (await dataRequest('/api/translate', 'POST', { from, content, model })).content;
}
