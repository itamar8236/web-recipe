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

  it('sorts by newest, oldest, protein or calories, a page at a time, with unknown values last', async () => {
    const nutrition = [
      [300, 10],
      [null, null],
      [800, 40],
      [120, 25],
    ];
    for (let i = 0; i < 12; i++) {
      const recipe = await newRecipe(dana, `R${i + 1}`);
      const [calories, protein] = nutrition[i % 4];
      await as(dana).put(`/api/recipes/${recipe.id}`, { en: recipe.en, he: recipe.he, calories, protein });
    }

    const order = async (sort) => {
      const first = await browse(noa, `sort=${sort}`);
      expect(first.recipes).toHaveLength(10);
      const second = await browse(noa, `sort=${sort}&after=${first.next}`);
      expect(second.next).toBeNull();
      return [...first.recipes, ...second.recipes].map((recipe) => recipe.en.name);
    };

    const oldest = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
    expect(await order('oldest')).toEqual(oldest);
    expect(await order('newest')).toEqual([...oldest].reverse());
    expect(await order('protein')).toEqual(['R3', 'R7', 'R11', 'R4', 'R8', 'R12', 'R1', 'R5', 'R9', 'R2', 'R6', 'R10']);
    expect(await order('kcal_high')).toEqual(['R3', 'R7', 'R11', 'R1', 'R5', 'R9', 'R4', 'R8', 'R12', 'R2', 'R6', 'R10']);
    expect(await order('kcal_low')).toEqual(['R4', 'R8', 'R12', 'R1', 'R5', 'R9', 'R3', 'R7', 'R11', 'R2', 'R6', 'R10']);
  });

  it('rejects an unknown sort', async () => {
    expect((await as(noa).get('/api/browse?sort=tastiest')).status).toBe(400);
    expect((await as(noa).get('/api/browse?sort=random')).status).toBe(400); // random needs a seed
    expect((await call('/api/browse?sort=newest')).status).toBe(401);
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

    // Calories and protein come with the copy, but Browse itself doesn't show them.
    await as(dana).put(`/api/recipes/${original.id}`, { en: original.en, he: original.he, calories: 300, protein: 9 });
    const withNutrition = await (await copy(noa, original.id)).json();
    expect(withNutrition.recipe).toMatchObject({ calories: 300, protein: 9 });
    const [browsed] = (await browse(noa)).recipes;
    expect(browsed.author).toBe('');
    expect(browsed).not.toHaveProperty('calories');
    expect(browsed).not.toHaveProperty('protein');

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

    await env.DB.prepare(`UPDATE recipes SET author = 'Tasty Home' WHERE id = ?`).bind(id).run();
    const browsed = (await browse(noa)).recipes.find((r) => r.id === id);
    expect(browsed.author).toBe('Tasty Home');

    const { recipe } = await (await copy(noa, id)).json();
    expect(recipe).toMatchObject({ link, sourceModel: 'some-model', author: 'Tasty Home' });
  });

  it('keeps the recipe in Browse, and saving it again makes another copy', async () => {
    const original = await newRecipe(dana, 'Toast');
    expect((await copy(noa, original.id)).status).toBe(201);
    expect(await browseNames(noa)).toEqual(['Toast']);

    expect((await copy(noa, original.id)).status).toBe(201);
    expect(await myRecipes(noa)).toHaveLength(2);
  });

  it('refuses your own recipe, a missing one, and a visitor', async () => {
    const mine = await newRecipe(noa, 'Mine');
    expect((await copy(noa, mine.id)).status).toBe(404);
    expect((await copy(noa, 9999)).status).toBe(404);
    expect((await call('/api/browse/1/copy', { method: 'POST', body: {} })).status).toBe(401);
  });
});
