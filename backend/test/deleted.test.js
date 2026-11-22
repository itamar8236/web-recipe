import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { purgeDeleted } from '../src/deleted.js';
import { call, cookiesFrom, register } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

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

const newRecipe = async (who = cookie) => {
  const body = { en: content('Soup', ['water', 'salt'], ['boil']), he: content('מרק'), calories: 120, protein: 4, author: 'Tom Smith' };
  return (await (await as(who).post('/api/recipes', body)).json()).recipe;
};
const listDeleted = async (who = cookie) => (await (await as(who).get('/api/deleted-recipes')).json()).recipes;
const listRecipes = async (who = cookie) => (await (await as(who).get('/api/recipes')).json()).recipes;
// Moves every bin row back in time, as if it had been deleted `days` ago.
const ageBin = (days) =>
  env.DB.prepare('UPDATE deleted_recipes SET deleted_at = deleted_at - ?').bind(days * DAY).run();

describe('recently deleted', () => {
  it('moves a deleted recipe to the bin, out of the recipes list', async () => {
    const recipe = await newRecipe();
    expect((await as(cookie).del(`/api/recipes/${recipe.id}`)).status).toBe(200);

    expect(await listRecipes()).toEqual([]);
    const [binned] = await listDeleted();
    expect(binned.en.name).toBe('Soup');
    expect(binned.he.name).toBe('מרק');
    expect(binned.expiresAt - binned.deletedAt).toBe(30 * DAY);
  });

  it('restores the recipe with its text, author, favorite, public flag and tags', async () => {
    const recipe = await newRecipe();
    await as(cookie).put(`/api/recipes/${recipe.id}/tags`, { tags: ['Dinner', 'Quick'] });
    await as(cookie).put(`/api/recipes/${recipe.id}/favorite`, { favorite: true });
    await as(cookie).put(`/api/recipes/${recipe.id}/public`, { public: false });
    await as(cookie).del(`/api/recipes/${recipe.id}`);
    // The tags were only on this recipe, so they are gone until it comes back.
    expect((await (await as(cookie).get('/api/tags')).json()).tags).toEqual([]);

    const [binned] = await listDeleted();
    const response = await as(cookie).post(`/api/deleted-recipes/${binned.id}/restore`);
    expect(response.status).toBe(200);
    const { recipe: restored, tags } = await response.json();

    expect(tags.map((tag) => tag.name).sort()).toEqual(['Dinner', 'Quick']);
    expect(restored).toMatchObject({
      favorite: true,
      public: false,
      calories: 120,
      protein: 4,
      author: 'Tom Smith',
      en: { name: 'Soup', ingredients: ['water', 'salt'], steps: ['boil'] },
      he: { name: 'מרק', ingredients: [], steps: [] },
      tagIds: tags.map((tag) => tag.id).sort((a, b) => a - b),
    });
    expect(await listRecipes()).toEqual([restored]);
    expect(await listDeleted()).toEqual([]);
  });

  it('links a restored recipe to a tag that still exists, whatever its case', async () => {
    const kept = await newRecipe();
    const binned = await newRecipe();
    await as(cookie).put(`/api/recipes/${kept.id}/tags`, { tags: ['Dinner'] });
    await as(cookie).put(`/api/recipes/${binned.id}/tags`, { tags: ['Dinner'] });
    await as(cookie).del(`/api/recipes/${binned.id}`);
    const [tag] = (await (await as(cookie).get('/api/tags')).json()).tags;
    await as(cookie).put(`/api/tags/${tag.id}`, { name: 'DINNER' });

    const [row] = await listDeleted();
    const { recipe, tags } = await (await as(cookie).post(`/api/deleted-recipes/${row.id}/restore`)).json();
    expect(tags).toEqual([{ id: tag.id, name: 'DINNER' }]);
    expect(recipe.tagIds).toEqual([tag.id]);
  });

  it("never shows or restores another user's deleted recipe", async () => {
    const recipe = await newRecipe();
    await as(cookie).del(`/api/recipes/${recipe.id}`);
    const [row] = await listDeleted();
    const other = cookiesFrom(await register('omer'));

    expect(await listDeleted(other)).toEqual([]);
    expect((await as(other).post(`/api/deleted-recipes/${row.id}/restore`)).status).toBe(404);
    expect(await listRecipes(other)).toEqual([]);
    expect(await listDeleted()).toHaveLength(1);
  });

  it('restores a recipe only once', async () => {
    const recipe = await newRecipe();
    await as(cookie).del(`/api/recipes/${recipe.id}`);
    const [row] = await listDeleted();
    await as(cookie).post(`/api/deleted-recipes/${row.id}/restore`);

    expect((await as(cookie).post(`/api/deleted-recipes/${row.id}/restore`)).status).toBe(404);
    expect(await listRecipes()).toHaveLength(1);
  });

  it('hides and refuses a recipe deleted more than 30 days ago, and the cron job removes it', async () => {
    const old = await newRecipe();
    await as(cookie).del(`/api/recipes/${old.id}`);
    await ageBin(31);
    const recent = await newRecipe();
    await as(cookie).del(`/api/recipes/${recent.id}`);
    await ageBin(29); // the old one is now 60 days old, the recent one 29

    const shown = await listDeleted();
    expect(shown).toHaveLength(1);
    const { results } = await env.DB.prepare('SELECT id FROM deleted_recipes ORDER BY id').all();
    const oldRow = results.find((row) => row.id !== shown[0].id);
    expect((await as(cookie).post(`/api/deleted-recipes/${oldRow.id}/restore`)).status).toBe(404);

    await purgeDeleted(env);
    const left = await env.DB.prepare('SELECT id FROM deleted_recipes').all();
    expect(left.results.map((row) => row.id)).toEqual([shown[0].id]);
  });

  it('runs the purge from the scheduled handler', async () => {
    const recipe = await newRecipe();
    await as(cookie).del(`/api/recipes/${recipe.id}`);
    await ageBin(30);

    await worker.scheduled({}, env);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM deleted_recipes').first()).n).toBe(0);
  });

  it('needs a login and the right method', async () => {
    expect((await call('/api/deleted-recipes')).status).toBe(401);
    expect((await call('/api/deleted-recipes/1/restore', { method: 'POST' })).status).toBe(401);
    expect((await as(cookie).get('/api/deleted-recipes/1/restore')).status).toBe(405);
    expect((await as(cookie).post('/api/deleted-recipes/999/restore')).status).toBe(404);
  });
});
