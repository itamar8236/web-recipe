import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { errorMessage, pickLanguage, strings } from './i18n';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

beforeEach(() => api.resetData());

const newRecipe = (name, folderId = null) =>
  api.saveRecipe(null, { folderId, en: content(name), he: content('') });

describe('starting data', () => {
  it('starts with no folders and no recipes', async () => {
    expect(await api.getFolders()).toEqual([]);
    expect(await api.getRecipes()).toEqual([]);
  });
});

describe('recipes', () => {
  it('saves a new recipe and trims blank lines', async () => {
    const folder = await api.createFolder('Breakfast');
    const saved = await api.saveRecipe(null, {
      folderId: folder.id,
      en: content(' Pancakes ', ['flour', '  ', ' milk '], ['mix', '']),
      he: content(''),
    });
    const loaded = await api.getRecipe(saved.id);
    expect(loaded.en).toEqual(content('Pancakes', ['flour', 'milk'], ['mix']));
    expect(loaded.folderId).toBe(folder.id);
  });

  it('accepts a recipe written only in Hebrew', async () => {
    const saved = await api.saveRecipe(null, { folderId: null, en: content(''), he: content('פנקייק') });
    expect(saved.he.name).toBe('פנקייק');
  });

  it('rejects a recipe with no name in either language', async () => {
    await expect(api.saveRecipe(null, { folderId: null, en: content(''), he: content('  ') })).rejects.toThrow();
  });

  it('updates an existing recipe', async () => {
    const folder = await api.createFolder('Dinner');
    const recipe = await newRecipe('Shakshuka');
    await api.saveRecipe(recipe.id, { folderId: folder.id, en: content('Green Shakshuka'), he: content('') });
    const loaded = await api.getRecipe(recipe.id);
    expect(loaded.en.name).toBe('Green Shakshuka');
    expect(loaded.folderId).toBe(folder.id);
  });

  it('manual recipes have no source link', async () => {
    const manual = await newRecipe('Toast');
    expect(manual.link).toBe('');
  });

  it('toggles favorite, and edits keep it', async () => {
    const { id } = await newRecipe('Lemon Chicken');
    await api.toggleFavorite(id);
    await api.saveRecipe(id, { folderId: null, en: content('Lemon Chicken v2'), he: content('') });
    expect((await api.getRecipe(id)).favorite).toBe(true);
    await api.toggleFavorite(id);
    expect((await api.getRecipe(id)).favorite).toBe(false);
  });

  it('new recipes are not favorites', async () => {
    const saved = await api.saveRecipe(null, { folderId: null, en: content('Toast'), he: content('') });
    expect(saved.favorite).toBe(false);
  });

  it('deletes a recipe', async () => {
    const { id } = await newRecipe('Toast');
    await api.deleteRecipe(id);
    expect(await api.getRecipe(id)).toBeNull();
  });
});

describe('folders', () => {
  it('creates and renames a folder', async () => {
    const folder = await api.createFolder(' Soups ');
    await api.renameFolder(folder.id, 'Hot soups');
    const folders = await api.getFolders();
    expect(folders.find((f) => f.id === folder.id).name).toBe('Hot soups');
  });

  it('rejects an empty folder name', async () => {
    await expect(api.createFolder('   ')).rejects.toThrow();
  });

  it('refuses to delete a folder that still has recipes', async () => {
    const folder = await api.createFolder('Breakfast');
    const recipe = await newRecipe('Shakshuka', folder.id);
    await expect(api.deleteFolder(folder.id)).rejects.toThrow();
    expect((await api.getFolders()).some((f) => f.id === folder.id)).toBe(true);
    expect((await api.getRecipe(recipe.id)).folderId).toBe(folder.id);
  });

  it('deletes an empty folder', async () => {
    const folder = await api.createFolder('Breakfast');
    const recipe = await newRecipe('Shakshuka', folder.id);
    await api.deleteRecipe(recipe.id);
    await api.deleteFolder(folder.id);
    expect((await api.getFolders()).some((f) => f.id === folder.id)).toBe(false);
  });
});

describe('pickLanguage', () => {
  it('uses the current language when it has a name', () => {
    const recipe = { en: content('Tea'), he: content('תה') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'תה', translated: true });
  });

  it('falls back to the other language when empty', () => {
    const recipe = { en: content('Tea'), he: content('') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'Tea', translated: false });
  });
});

describe('login', () => {
  const mockFetch = (status, body) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));

  afterEach(() => vi.unstubAllGlobals());

  it('getMe returns the user, or null when not logged in', async () => {
    mockFetch(200, { user: { id: 1, username: 'dana', is_admin: false } });
    expect((await api.getMe()).username).toBe('dana');
    mockFetch(401, { error: 'not_logged_in' });
    expect(await api.getMe()).toBeNull();
  });

  it('login sends the credentials as JSON', async () => {
    mockFetch(200, { user: { id: 1, username: 'dana' } });
    await api.login('dana', 'password123');
    const [path, options] = fetch.mock.calls[0];
    expect(path).toBe('/api/auth/login');
    expect(JSON.parse(options.body)).toEqual({ username: 'dana', password: 'password123' });
  });

  it('turns backend errors into ApiError with the code', async () => {
    mockFetch(401, { error: 'invalid_credentials' });
    await expect(api.login('dana', 'nope')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('reports an unreachable backend as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fail'); }));
    await expect(api.register('dana', 'password123')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('errorMessage', () => {
  it('maps known codes and falls back to a generic message', () => {
    expect(errorMessage(strings.en, { code: 'username_taken' })).toBe(strings.en.errUsernameTaken);
    expect(errorMessage(strings.he, { code: 'weird' })).toBe(strings.he.errGeneric);
  });
});
