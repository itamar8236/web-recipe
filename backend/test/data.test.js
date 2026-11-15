import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { call, cookiesFrom, register } from './helpers.js';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });
const recipeBody = (name) => ({ en: content(name), he: content('') });

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

const newRecipe = async (name = 'Toast', who = cookie) =>
  (await (await as(who).post('/api/recipes', recipeBody(name))).json()).recipe;
// Sets a recipe's tags and returns { recipe, tags } as the API answers.
const setTags = async (recipeId, tags, who = cookie) =>
  (await as(who).put(`/api/recipes/${recipeId}/tags`, { tags })).json();
const listTags = async (who = cookie) => (await (await as(who).get('/api/tags')).json()).tags;

describe('tags', () => {
  it('gives a recipe several tags, creating the new ones (trimmed)', async () => {
    const recipe = await newRecipe();
    const response = await as(cookie).put(`/api/recipes/${recipe.id}/tags`, { tags: ['  Soups ', 'Quick'] });
    expect(response.status).toBe(200);
    const { recipe: tagged, tags } = await response.json();

    expect(tags.map((tag) => tag.name)).toEqual(['Soups', 'Quick']);
    expect(tagged.tagIds).toEqual(tags.map((tag) => tag.id));
    expect(await listTags()).toEqual(tags);
    const loaded = await (await as(cookie).get(`/api/recipes/${recipe.id}`)).json();
    expect(loaded.recipe.tagIds).toEqual(tagged.tagIds);
  });

  it('reuses an existing tag, whatever the case, and keeps a repeated name once', async () => {
    const first = await newRecipe('Soup');
    const second = await newRecipe('Stew');
    const { tags } = await setTags(first.id, ['Dinner']);

    const { recipe, tags: after } = await setTags(second.id, ['dinner', 'DINNER']);
    expect(after).toEqual(tags);
    expect(recipe.tagIds).toEqual([tags[0].id]);
  });

  it('deletes a tag when its last recipe drops it or is deleted', async () => {
    const first = await newRecipe('Soup');
    const second = await newRecipe('Stew');
    await setTags(first.id, ['Dinner', 'Quick']);
    await setTags(second.id, ['Dinner']);

    const { recipe, tags } = await setTags(first.id, []);
    expect(recipe.tagIds).toEqual([]);
    expect(tags.map((tag) => tag.name)).toEqual(['Dinner']);

    await as(cookie).del(`/api/recipes/${second.id}`);
    expect(await listTags()).toEqual([]);
  });

  it('renames a tag, but not to the name of another one', async () => {
    const recipe = await newRecipe();
    const { tags } = await setTags(recipe.id, ['Soups', 'Quick']);
    const [soups, quick] = tags;

    const renamed = await as(cookie).put(`/api/tags/${soups.id}`, { name: ' Hot soups ' });
    expect((await renamed.json()).tag).toEqual({ id: soups.id, name: 'Hot soups' });
    const recased = await as(cookie).put(`/api/tags/${quick.id}`, { name: 'QUICK' });
    expect((await recased.json()).tag.name).toBe('QUICK');

    const clash = await as(cookie).put(`/api/tags/${quick.id}`, { name: 'hot soups' });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe('tag_exists');
    expect((await as(cookie).put('/api/tags/999', { name: 'x' })).status).toBe(404);
  });

  it('rejects bad input', async () => {
    const recipe = await newRecipe();
    const put = (body) => as(cookie).put(`/api/recipes/${recipe.id}/tags`, body);
    expect((await put({})).status).toBe(400);
    expect((await put({ tags: [1] })).status).toBe(400);
    expect((await (await put({ tags: ['  '] })).json()).error).toBe('name_required');
    expect((await (await put({ tags: ['x'.repeat(101)] })).json()).error).toBe('too_long');
    const many = Array.from({ length: 21 }, (_, i) => `tag ${i}`);
    expect((await (await put({ tags: many })).json()).error).toBe('too_long');
    expect((await as(cookie).put('/api/recipes/999/tags', { tags: [] })).status).toBe(404);
    expect(await listTags()).toEqual([]);

    const empty = await as(cookie).put('/api/tags/1', { name: '   ' });
    expect((await empty.json()).error).toBe('name_required');
    expect((await as(cookie).put('/api/tags/1', { name: 'x'.repeat(101) })).status).toBe(400);
  });
});

describe('recipes', () => {
  it('saves a recipe in both languages and reads it back', async () => {
    const response = await as(cookie).post('/api/recipes', {
      en: content(' Pancakes ', ['flour', '  ', ' milk '], ['mix', '']),
      he: content('פנקייק', ['קמח'], ['לערבב']),
    });
    expect(response.status).toBe(201);
    const { recipe } = await response.json();
    expect(recipe).toMatchObject({
      tagIds: [],
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

  it('updates a recipe and keeps its favorite and tags', async () => {
    const recipe = await newRecipe('Shakshuka');
    await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: true });
    const { tags } = await setTags(recipe.id, ['Dinner']);

    const response = await as(cookie).put(`/api/recipes/${recipe.id}`, recipeBody('Green Shakshuka'));
    expect(response.status).toBe(200);
    expect((await response.json()).recipe).toMatchObject({
      tagIds: [tags[0].id],
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
    const noName = await as(cookie).post('/api/recipes', { en: content(' '), he: content('') });
    expect((await noName.json()).error).toBe('name_required');
    expect((await as(cookie).post('/api/recipes', { en: content('Toast') })).status).toBe(400);
    const badLines = { en: { name: 'Toast', ingredients: [1], steps: [] }, he: content('') };
    expect((await as(cookie).post('/api/recipes', badLines)).status).toBe(400);
    const tooLong = await as(cookie).post('/api/recipes', recipeBody('x'.repeat(201)));
    expect((await tooLong.json()).error).toBe('too_long');
    expect((await as(cookie).put('/api/recipes/999', recipeBody('Toast'))).status).toBe(404);
  });

  it('refuses a body sent as a plain form (another site posting it)', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: cookie },
        body: JSON.stringify(recipeBody('Evil')),
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
    await as(cookie).put(`/api/recipes/${recipe.id}`, { en: content('Better toast'), he: content('טוסט') });
    expect(await label()).toBeNull();
  });
});

describe('privacy', () => {
  it("never shows or changes another user's tags and recipes", async () => {
    const recipe = await newRecipe('Secret');
    const { tags } = await setTags(recipe.id, ['Mine']);
    const other = cookiesFrom(await register('noa'));
    const them = as(other);

    expect(await listTags(other)).toEqual([]);
    expect((await (await them.get('/api/recipes')).json()).recipes).toEqual([]);
    expect((await them.get(`/api/recipes/${recipe.id}`)).status).toBe(404);
    expect((await them.put(`/api/recipes/${recipe.id}`, recipeBody('Stolen'))).status).toBe(404);
    expect((await them.put(`/api/recipes/${recipe.id}/favorite`, { favorite: true })).status).toBe(404);
    expect((await them.put(`/api/recipes/${recipe.id}/tags`, { tags: [] })).status).toBe(404);
    expect((await them.del(`/api/recipes/${recipe.id}`)).status).toBe(404);
    expect((await them.put(`/api/tags/${tags[0].id}`, { name: 'Stolen' })).status).toBe(404);

    // The same name is the other user's own, separate tag.
    const theirs = await newRecipe('Theirs', other);
    const { tags: theirTags } = await setTags(theirs.id, ['Mine'], other);
    expect(theirTags).toHaveLength(1);
    expect(theirTags[0].id).not.toBe(tags[0].id);

    const mine = await (await as(cookie).get(`/api/recipes/${recipe.id}`)).json();
    expect(mine.recipe).toMatchObject({ favorite: false, tagIds: [tags[0].id], en: { name: 'Secret' } });
    expect(await listTags()).toEqual(tags);
  });

  it('requires a login', async () => {
    expect((await call('/api/tags')).status).toBe(401);
    expect((await call('/api/recipes/1/tags', { method: 'PUT', body: { tags: [] } })).status).toBe(401);
    expect((await call('/api/recipes', { method: 'POST', body: recipeBody('Toast') })).status).toBe(401);
  });

  it('answers 405 for a method a data path does not support', async () => {
    expect((await call('/api/tags/1', { cookie })).status).toBe(405);
    expect((await call('/api/tags', { method: 'POST', body: { name: 'x' }, cookie })).status).toBe(405);
    expect((await call('/api/tags/1/favorite', { cookie })).status).toBe(404);
  });
});
