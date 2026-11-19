import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ModelBusyError } from '../src/import/llm.js';
import { quotaDay } from '../src/import/models.js';
import { handleNutrition } from '../src/nutrition.js';
import { call, cookiesFrom, insertUser, register } from './helpers.js';

const SMALL = env.LLM_TRANSLATE_MODELS;
const RECIPE = { name: 'Omelette', ingredients: ['3 eggs', '1 tbsp butter'], steps: ['Beat the eggs', 'Fry'] };

// A model answer: whole-recipe totals and servings.
const totals = (totalCalories, totalProtein, servings) => ({ ingredients: [], totalCalories, totalProtein, servings });
const answering = (result) =>
  vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });

const estimate = async (body, llm, userId) =>
  handleNutrition(
    new Request('http://localhost/api/nutrition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
    '/api/nutrition',
    userId ?? (await insertUser()),
    llm,
  );
const rows = async () => (await env.DB.prepare(`SELECT * FROM llm_requests ORDER BY id`).all()).results;
const insertRecipe = async (userId) =>
  (await env.DB.prepare(`INSERT INTO recipes (user_id, name_en) VALUES (?, 'Tea') RETURNING id`).bind(userId).first()).id;

describe('POST /api/nutrition', () => {
  it('needs a session', async () => {
    const response = await call('/api/nutrition', { method: 'POST', body: { content: RECIPE } });
    expect(response.status).toBe(401);
  });

  it('answers 405 for another method when logged in', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/nutrition', { cookie })).status).toBe(405);
  });

  it('estimates on the small model, divides by the servings, records the request and saves nothing', async () => {
    const userId = await insertUser();
    const recipeId = await insertRecipe(userId);
    const llm = answering(totals(641, 39, 2));
    const response = await estimate({ content: RECIPE, recipeId }, llm, userId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calories: 321, protein: 20 });
    const [args] = llm.mock.calls[0];
    expect(args).toMatchObject({ model: SMALL });
    expect(args.prompt).toContain('3 eggs');
    expect(args.schema.required).toEqual(['ingredients', 'totalCalories', 'totalProtein', 'servings']);
    expect(await rows()).toEqual([
      expect.objectContaining({ user_id: userId, purpose: 'nutrition', stage: 'nutrition', status: 'done', model: SMALL, recipe_id: recipeId, quota_day: quotaDay(Date.now()) }),
    ]);
    const recipe = await env.DB.prepare('SELECT calories, protein FROM recipes WHERE id = ?').bind(recipeId).first();
    expect(recipe).toEqual({ calories: null, protein: null });
  });

  it.each([
    ['no content', {}, 'invalid_request'],
    ['a recipe id that is not a number', { content: RECIPE, recipeId: '5' }, 'invalid_request'],
    ['no ingredients', { content: { ...RECIPE, ingredients: [' '] } }, 'no_ingredients'],
  ])('answers 400 for %s, calling nothing', async (_, body, error) => {
    const llm = answering(totals(1, 1, 1));
    const response = await estimate(body, llm);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(error);
    expect(llm).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('answers 404 for another user’s recipe', async () => {
    const recipeId = await insertRecipe(await insertUser('dana'));
    const response = await estimate({ content: RECIPE, recipeId }, answering(totals(1, 1, 1)), await insertUser('noa'));
    expect(response.status).toBe(404);
  });

  it.each([
    ['a missing total', { totalCalories: 300, servings: 2 }],
    ['no servings', totals(300, 10, 0)],
    ['far too many servings', totals(300, 10, 1000)],
    ['a negative total', totals(-5, 10, 1)],
    ['a serving out of range', totals(99999, 10, 1)],
    ['not numbers', { totalCalories: 'a lot', totalProtein: 'some', servings: 2 }],
  ])('answers 502 bad_result for an answer with %s', async (_, output) => {
    const response = await estimate({ content: RECIPE }, answering(output));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('bad_result');
    expect((await rows())[0]).toMatchObject({ status: 'failed', error: 'bad_result', model: SMALL });
  });

  it('answers 503 model_busy when its model is busy', async () => {
    const response = await estimate({ content: RECIPE }, answering(new ModelBusyError('busy')));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('model_busy');
  });
});
