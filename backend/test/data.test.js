import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { call, cookiesFrom, register } from './helpers.js';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });
const recipeBody = (name, folderId = null) => ({ folderId, en: content(name), he: content('') });

let cookie;
beforeEach(async () => {
  cookie = cookiesFrom(await register('dana'));
});

const as = (who) => ({
  get: (path) => call(path, { cookie: who }),
  post: (path, body) => call(path, { method: 'POST', body, cookie: who }),
  put: (path, body) => call(path, { method: 'PUT', body, cookie: who }),
  del: (path) => call(path, { method: 'DELETE', cookie: who }),
});

const newFolder = async (name = 'Breakfast', who = cookie) =>
  (await (await as(who).post('/api/folders', { name })).json()).folder;
const newRecipe = async (name = 'Toast', folderId = null, who = cookie) =>
  (await (await as(who).post('/api/recipes', recipeBody(name, folderId))).json()).recipe;

describe('folders', () => {
  it('creates, lists and renames a folder (trimming the name)', async () => {
    const created = await as(cookie).post('/api/folders', { name: '  Soups ' });
    expect(created.status).toBe(201);
    const { folder } = await created.json();
    expect(folder.name).toBe('Soups');

    const renamed = await as(cookie).put(`/api/folders/${folder.id}`, { name: 'Hot soups' });
    expect((await renamed.json()).folder.name).toBe('Hot soups');

    const { folders } = await (await as(cookie).get('/api/folders')).json();
    expect(folders).toEqual([{ id: folder.id, name: 'Hot soups' }]);
  });

  it('rejects a missing, empty or too long name', async () => {
    expect((await as(cookie).post('/api/folders', {})).status).toBe(400);
    const empty = await as(cookie).post('/api/folders', { name: '   ' });
    expect((await empty.json()).error).toBe('name_required');
    expect((await as(cookie).post('/api/folders', { name: 'x'.repeat(101) })).status).toBe(400);
  });

  it('deletes only an empty folder', async () => {
    const folder = await newFolder();
    const recipe = await newRecipe('Shakshuka', folder.id);

    const refused = await as(cookie).del(`/api/folders/${folder.id}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('folder_not_empty');

    await as(cookie).del(`/api/recipes/${recipe.id}`);
    expect((await as(cookie).del(`/api/folders/${folder.id}`)).status).toBe(200);
    expect((await (await as(cookie).get('/api/folders')).json()).folders).toEqual([]);
  });

  it('answers 404 for a folder that does not exist', async () => {
    expect((await as(cookie).put('/api/folders/999', { name: 'x' })).status).toBe(404);
    expect((await as(cookie).del('/api/folders/999')).status).toBe(404);
  });
});

describe('recipes', () => {
  it('saves a recipe in both languages and reads it back', async () => {
    const folder = await newFolder();
    const response = await as(cookie).post('/api/recipes', {
      folderId: folder.id,
      en: content(' Pancakes ', ['flour', '  ', ' milk '], ['mix', '']),
      he: content('פנקייק', ['קמח'], ['לערבב']),
    });
    expect(response.status).toBe(201);
    const { recipe } = await response.json();
    expect(recipe).toMatchObject({
      folderId: folder.id,
      favorite: false,
      link: '',
      en: content('Pancakes', ['flour', 'milk'], ['mix']),
      he: content('פנקייק', ['קמח'], ['לערבב']),
    });

    const loaded = await (await as(cookie).get(`/api/recipes/${recipe.id}`)).json();
    expect(loaded.recipe).toEqual(recipe);
    const { recipes } = await (await as(cookie).get('/api/recipes')).json();
    expect(recipes).toEqual([recipe]);
  });

  it('updates a recipe and keeps its favorite', async () => {
    const recipe = await newRecipe('Shakshuka');
    await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: true });
    const folder = await newFolder('Dinner');

    const response = await as(cookie).put(`/api/recipes/${recipe.id}`, recipeBody('Green Shakshuka', folder.id));
    expect(response.status).toBe(200);
    expect((await response.json()).recipe).toMatchObject({
      folderId: folder.id,
      favorite: true,
      en: { name: 'Green Shakshuka' },
    });
  });

  it('sets and clears a favorite', async () => {
    const recipe = await newRecipe();
    const on = await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: true });
    expect((await on.json()).recipe.favorite).toBe(true);
    const off = await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: false });
    expect((await off.json()).recipe.favorite).toBe(false);
    expect((await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: 'yes' })).status).toBe(400);
  });

  it('deletes a recipe', async () => {
    const recipe = await newRecipe();
    expect((await as(cookie).del(`/api/recipes/${recipe.id}`)).status).toBe(200);
    expect((await as(cookie).get(`/api/recipes/${recipe.id}`)).status).toBe(404);
    expect((await as(cookie).del(`/api/recipes/${recipe.id}`)).status).toBe(404);
  });

  it('rejects bad input', async () => {
    const noName = await as(cookie).post('/api/recipes', { folderId: null, en: content(' '), he: content('') });
    expect((await noName.json()).error).toBe('name_required');
    expect((await as(cookie).post('/api/recipes', { en: content('Toast') })).status).toBe(400);
    const badLines = { folderId: null, en: { name: 'Toast', ingredients: [1], steps: [] }, he: content('') };
    expect((await as(cookie).post('/api/recipes', badLines)).status).toBe(400);
    const tooLong = await as(cookie).post('/api/recipes', recipeBody('x'.repeat(201)));
    expect((await tooLong.json()).error).toBe('too_long');
    const missingFolder = await as(cookie).post('/api/recipes', recipeBody('Toast', 999));
    expect((await missingFolder.json()).error).toBe('folder_not_found');
    expect((await as(cookie).put('/api/recipes/999', recipeBody('Toast'))).status).toBe(404);
  });

  it('refuses a body sent as a plain form (another site posting it)', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: cookie },
        body: JSON.stringify({ name: 'Evil' }),
      }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('clears the machine-translated label only when that language is edited', async () => {
    const recipe = await newRecipe('Toast');
    await env.DB.prepare("UPDATE recipes SET machine_translated_lang = 'he' WHERE id = ?").bind(recipe.id).run();
    const label = async () =>
      (await env.DB.prepare('SELECT machine_translated_lang AS lang FROM recipes WHERE id = ?').bind(recipe.id).first()).lang;

    await as(cookie).put(`/api/recipes/${recipe.id}`, recipeBody('Better toast'));
    expect(await label()).toBe('he');
    await as(cookie).put(`/api/recipes/${recipe.id}`, { folderId: null, en: content('Better toast'), he: content('טוסט') });
    expect(await label()).toBeNull();
  });
});

describe('privacy', () => {
  it("never shows or changes another user's folders and recipes", async () => {
    const folder = await newFolder('Mine');
    const recipe = await newRecipe('Secret', folder.id);
    const other = cookiesFrom(await register('noa'));
    const them = as(other);

    expect((await (await them.get('/api/folders')).json()).folders).toEqual([]);
    expect((await (await them.get('/api/recipes')).json()).recipes).toEqual([]);
    expect((await them.get(`/api/recipes/${recipe.id}`)).status).toBe(404);
    expect((await them.put(`/api/recipes/${recipe.id}`, recipeBody('Stolen'))).status).toBe(404);
    expect((await them.put(`/api/recipes/${recipe.id}/favorite`, { favorite: true })).status).toBe(404);
    expect((await them.del(`/api/recipes/${recipe.id}`)).status).toBe(404);
    expect((await them.put(`/api/folders/${folder.id}`, { name: 'Stolen' })).status).toBe(404);
    expect((await them.del(`/api/folders/${folder.id}`)).status).toBe(404);
    const intoMyFolder = await them.post('/api/recipes', recipeBody('Sneaky', folder.id));
    expect((await intoMyFolder.json()).error).toBe('folder_not_found');

    const mine = await (await as(cookie).get(`/api/recipes/${recipe.id}`)).json();
    expect(mine.recipe).toMatchObject({ favorite: false, en: { name: 'Secret' } });
  });

  it('requires a login', async () => {
    expect((await call('/api/folders')).status).toBe(401);
    expect((await call('/api/recipes', { method: 'POST', body: recipeBody('Toast') })).status).toBe(401);
  });

  it('answers 405 for a method a data path does not support', async () => {
    expect((await call('/api/folders/1', { cookie })).status).toBe(405);
    expect((await call('/api/folders/1/favorite', { cookie })).status).toBe(404);
  });
});
