import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, cookiesFrom, register } from './helpers.js';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

const as = (who) => ({
  get: (path) => call(path, { cookie: who }),
  post: (path, body) => call(path, { method: 'POST', body, cookie: who }),
  put: (path, body) => call(path, { method: 'PUT', body, cookie: who }),
  del: (path) => call(path, { method: 'DELETE', cookie: who }),
});

const newRecipe = async (who, name, tags = []) => {
  const body = { en: content(name, ['flour'], ['mix']), he: content('') };
  const { recipe } = await (await as(who).post('/api/recipes', body)).json();
  if (tags.length) await as(who).put(`/api/recipes/${recipe.id}/tags`, { tags });
  return recipe;
};
const browse = async (who, query = 'seed=7') => (await as(who).get(`/api/browse?${query}`)).json();
const browseNames = async (who) => (await browse(who)).recipes.map((recipe) => recipe.en.name);
const copy = (who, id) => as(who).post(`/api/browse/${id}/copy`, {});
const myRecipes = async (who) => (await (await as(who).get('/api/recipes')).json()).recipes;
const myTagNames = async (who) => (await (await as(who).get('/api/tags')).json()).tags.map((tag) => tag.name);

let dana;
let noa;
beforeEach(async () => {
  dana = cookiesFrom(await register('dana'));
  noa = cookiesFrom(await register('noa'));
});

describe('public and private recipes', () => {
  it('makes a new recipe public by default, and private when the user chose that', async () => {
    expect((await newRecipe(dana, 'Toast')).public).toBe(true);

    const changed = await as(dana).put('/api/auth/me', { defaultPublic: false });
    expect((await changed.json()).user).toMatchObject({ defaultPublic: false, copyTags: true });
    expect((await newRecipe(dana, 'Soup')).public).toBe(false);
    expect((await (await as(dana).get('/api/auth/me')).json()).user.defaultPublic).toBe(false);
  });

  it('sets one recipe private or public, only for its owner', async () => {
    const recipe = await newRecipe(dana, 'Toast');
    const hidden = await as(dana).put(`/api/recipes/${recipe.id}/public`, { public: false });
    expect((await hidden.json()).recipe.public).toBe(false);
    expect((await as(dana).put(`/api/recipes/${recipe.id}/public`, { public: 'no' })).status).toBe(400);
    expect((await as(noa).put(`/api/recipes/${recipe.id}/public`, { public: true })).status).toBe(404);
    expect((await call(`/api/recipes/${recipe.id}/public`, { method: 'PUT', body: { public: true } })).status).toBe(401);
  });

  it('rejects a default that is not true or false', async () => {
    expect((await as(dana).put('/api/auth/me', { copyTags: 'yes' })).status).toBe(400);
    expect((await as(dana).put('/api/auth/me', { defaultPublic: 1 })).status).toBe(400);
  });
});

describe('browse', () => {
  it("shows other users' public recipes with who saved them and their tags, never your own", async () => {
    await newRecipe(dana, 'Toast', ['Breakfast', 'Quick']);
    await newRecipe(noa, 'Soup');

    const { recipes, next } = await browse(noa);
    expect(next).toBeNull();
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toMatchObject({ owner: 'dana', tags: ['Breakfast', 'Quick'], link: '' });
    expect(recipes[0].en).toEqual(content('Toast', ['flour'], ['mix']));
    expect(recipes[0]).not.toHaveProperty('favorite');
    expect(await browseNames(dana)).toEqual(['Soup']);
  });

  it('hides a private recipe', async () => {
    const recipe = await newRecipe(dana, 'Secret');
    await as(dana).put(`/api/recipes/${recipe.id}/public`, { public: false });
    expect(await browseNames(noa)).toEqual([]);
    expect((await copy(noa, recipe.id)).status).toBe(404);
  });

  it('loads in pages, in an order that is the same for one seed and differs between seeds', async () => {
    for (let i = 1; i <= 25; i++) await newRecipe(dana, `Recipe ${i}`);

    const order = async (seed) => {
      const names = [];
      let after = '';
      for (let page = 0; page < 5; page++) {
        const { recipes, next } = await browse(noa, `seed=${seed}${after}`);
        expect(recipes.length).toBeLessThanOrEqual(10);
        names.push(...recipes.map((recipe) => recipe.en.name));
        if (!next) break;
        after = `&after=${next}`;
      }
      return names;
    };

    const first = await order(1234);
    expect(first).toHaveLength(25);
    expect(new Set(first).size).toBe(25);
    expect(await order(1234)).toEqual(first);
    const other = await order(987654);
    expect(other).not.toEqual(first);
    expect([...other].sort()).toEqual([...first].sort());
    // Not simply oldest first.
    expect(first).not.toEqual(Array.from({ length: 25 }, (_, i) => `Recipe ${i + 1}`));
  });

  it('rejects a bad seed or page mark, and needs a login', async () => {
    expect((await as(noa).get('/api/browse')).status).toBe(400);
    expect((await as(noa).get('/api/browse?seed=0')).status).toBe(400);
    expect((await as(noa).get('/api/browse?seed=abc')).status).toBe(400);
    expect((await as(noa).get('/api/browse?seed=5&after=x.y')).status).toBe(400);
    expect((await call('/api/browse?seed=5')).status).toBe(401);
    expect((await as(noa).post('/api/browse', {})).status).toBe(405);
  });
});

describe('saving a copy', () => {
  it('makes an identical recipe of your own, with its tags', async () => {
    await newRecipe(noa, 'Mine', ['quick']);
    const original = await newRecipe(dana, 'Toast', ['Breakfast', 'Quick']);
    await as(dana).put(`/api/recipes/${original.id}/favorite`, { favorite: true });

    const response = await copy(noa, original.id);
    expect(response.status).toBe(201);
    const { recipe } = await response.json();
    expect(recipe).toMatchObject({ en: original.en, he: original.he, link: '', favorite: false, public: true });
    expect(recipe.id).not.toBe(original.id);
    // "Quick" is the tag noa already has, spelled her way.
    expect(await myTagNames(noa)).toEqual(['quick', 'Breakfast']);
    expect(recipe.tagIds).toHaveLength(2);
    expect(await myRecipes(noa)).toHaveLength(2);

    // The copy is noa's: changing it leaves dana's recipe alone.
    await as(noa).put(`/api/recipes/${recipe.id}`, { en: content('Changed'), he: content('') });
    expect((await myRecipes(dana))[0].en.name).toBe('Toast');
  });

  it('leaves the tags out and makes it private when those are the user’s defaults', async () => {
    const original = await newRecipe(dana, 'Toast', ['Breakfast']);
    await as(noa).put('/api/auth/me', { copyTags: false, defaultPublic: false });

    const { recipe } = await (await copy(noa, original.id)).json();
    expect(recipe).toMatchObject({ tagIds: [], public: false });
    expect(await myTagNames(noa)).toEqual([]);
  });

  it('keeps the link of an imported recipe', async () => {
    const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const danaId = (await env.DB.prepare("SELECT id FROM users WHERE username = 'dana'").first()).id;
    const { id } = await env.DB.prepare(
      `INSERT INTO recipes (user_id, platform, source_url, source_model, name_en)
       VALUES (?, 'youtube', ?, 'some-model', 'Shakshuka') RETURNING id`,
    )
      .bind(danaId, link)
      .first();

    const { recipe } = await (await copy(noa, id)).json();
    expect(recipe).toMatchObject({ link, sourceModel: 'some-model' });
  });

  it('saves a recipe once, and takes it out of Browse', async () => {
    const original = await newRecipe(dana, 'Toast');
    expect((await copy(noa, original.id)).status).toBe(201);

    const again = await copy(noa, original.id);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already_saved');
    expect(await myRecipes(noa)).toHaveLength(1);
    expect(await browseNames(noa)).toEqual([]);

    // Deleting the copy brings it back.
    await as(noa).del(`/api/recipes/${(await myRecipes(noa))[0].id}`);
    expect(await browseNames(noa)).toEqual(['Toast']);
  });

  it('shows a third user the original, not also every copy of it', async () => {
    const original = await newRecipe(dana, 'Toast');
    await copy(noa, original.id);
    const tal = cookiesFrom(await register('tal'));

    expect((await browse(tal)).recipes.map((recipe) => recipe.owner)).toEqual(['dana']);
    // Dana doesn't get her own recipe back as noa's copy.
    expect(await browseNames(dana)).toEqual([]);

    // Once the original is private, the copy is the one to find.
    await as(dana).put(`/api/recipes/${original.id}/public`, { public: false });
    expect((await browse(tal)).recipes.map((recipe) => recipe.owner)).toEqual(['noa']);
  });

  it('refuses your own recipe, a missing one, and a visitor', async () => {
    const mine = await newRecipe(noa, 'Mine');
    expect((await copy(noa, mine.id)).status).toBe(404);
    expect((await copy(noa, 9999)).status).toBe(404);
    expect((await call('/api/browse/1/copy', { method: 'POST', body: {} })).status).toBe(401);
  });
});
