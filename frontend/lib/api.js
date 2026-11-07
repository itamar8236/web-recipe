// Data layer for the UI. Its async functions are shaped like the future backend
// endpoints, so swapping the bodies for fetch() calls won't touch any component.

let nextId = 0;
const newId = () => ++nextId;

function emptyData() {
  return { folders: [], recipes: [] };
}

let db = emptyData();

// For tests: start again from a clean state.
export function resetData() {
  db = emptyData();
}

function cleanLines(lines) {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function cleanContent(content) {
  return {
    name: content.name.trim(),
    ingredients: cleanLines(content.ingredients),
    steps: cleanLines(content.steps),
  };
}

export async function getFolders() {
  return db.folders.map((folder) => ({ ...folder }));
}

export async function createFolder(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name is required');
  const folder = { id: newId(), name: trimmed };
  db.folders.push(folder);
  return { ...folder };
}

export async function renameFolder(id, name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name is required');
  const folder = db.folders.find((f) => f.id === id);
  if (folder) folder.name = trimmed;
}

// Only empty folders can be deleted, so recipes are never lost or moved by accident.
export async function deleteFolder(id) {
  if (db.recipes.some((r) => r.folderId === id)) throw new Error('Folder is not empty');
  db.folders = db.folders.filter((f) => f.id !== id);
}

export async function getRecipes() {
  return db.recipes.map((recipe) => ({ ...recipe }));
}

export async function getRecipe(id) {
  const recipe = db.recipes.find((r) => r.id === id);
  return recipe ? { ...recipe } : null;
}

// `data` is { folderId, en: {name, ingredients[], steps[]}, he: {...} }.
export async function saveRecipe(id, data) {
  const en = cleanContent(data.en);
  const he = cleanContent(data.he);
  if (!en.name && !he.name) throw new Error('Recipe name is required');
  const fields = { folderId: data.folderId ?? null, en, he };

  const existing = db.recipes.find((r) => r.id === id);
  if (existing) {
    Object.assign(existing, fields);
    return { ...existing };
  }
  const recipe = { id: newId(), link: '', favorite: false, ...fields };
  db.recipes.push(recipe);
  return { ...recipe };
}

export async function toggleFavorite(id) {
  const recipe = db.recipes.find((r) => r.id === id);
  if (recipe) recipe.favorite = !recipe.favorite;
  return recipe ? recipe.favorite : false;
}

export async function deleteRecipe(id) {
  db.recipes = db.recipes.filter((r) => r.id !== id);
}
