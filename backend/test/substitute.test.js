import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ModelBusyError } from '../src/import/llm.js';
import { quotaDay } from '../src/import/models.js';
import { handleSubstitute } from '../src/substitute.js';
import { call, cookiesFrom, insertUser, register } from './helpers.js';

const SMALL = env.LLM_TRANSLATE_MODELS;
const BUTTER = { name: 'Butter', amount: '1 tbsp oil', note: 'A little less rich.' };

const answering = (result) =>
  vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });

const substitute = (body, llm, userId) =>
  handleSubstitute(
    new Request('http://localhost/api/substitute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
    '/api/substitute',
    userId,
    llm,
  );
const rows = async () => (await env.DB.prepare(`SELECT * FROM llm_requests ORDER BY id`).all()).results;
const insertRecipe = async (userId) =>
  (
    await env.DB.prepare(
      `INSERT INTO recipes (user_id, name_en, ingredients_en, steps_en, name_he, ingredients_he)
       VALUES (?, 'Omelette', '["3 eggs","1 tbsp butter"]', '["Fry"]', 'חביתה', '["3 ביצים","כף חמאה"]') RETURNING id`,
    )
      .bind(userId)
      .first()
  ).id;

describe('POST /api/substitute', () => {
  it('needs a session', async () => {
    const response = await call('/api/substitute', { method: 'POST', body: { recipeId: 1, from: 'en', index: 0, lang: 'en' } });
    expect(response.status).toBe(401);
  });

  it('answers 405 for another method when logged in', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/substitute', { cookie })).status).toBe(405);
  });

  it('asks the small model about the chosen ingredient, records the request and saves nothing', async () => {
    const userId = await insertUser();
    const recipeId = await insertRecipe(userId);
    const llm = answering({ substitutes: [BUTTER, { name: ' ', amount: '', note: '' }] });
    const response = await substitute({ recipeId, from: 'he', index: 1, lang: 'en' }, llm, userId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ substitutes: [BUTTER] });
    const [args] = llm.mock.calls[0];
    expect(args).toMatchObject({ model: SMALL, logPrompt: false });
    expect(args.prompt).toContain('"כף חמאה"');
    expect(args.prompt).toContain('in English');
    expect(await rows()).toEqual([
      expect.objectContaining({ user_id: userId, purpose: 'substitution', stage: 'substitution', status: 'done', model: SMALL, recipe_id: recipeId, quota_day: quotaDay(Date.now()) }),
    ]);
  });

  it('answers an empty list when nothing would work', async () => {
    const userId = await insertUser();
    const response = await substitute({ recipeId: await insertRecipe(userId), from: 'en', index: 0, lang: 'he' }, answering({ substitutes: [] }), userId);
    expect(await response.json()).toEqual({ substitutes: [] });
  });

  it.each([
    ['no body fields', {}],
    ['a bad language', { from: 'fr', index: 0, lang: 'en' }],
    ['a negative index', { from: 'en', index: -1, lang: 'en' }],
    ['an index past the list', { from: 'en', index: 2, lang: 'en' }],
  ])('answers 400 for %s, calling nothing', async (_, fields) => {
    const userId = await insertUser();
    const llm = answering({ substitutes: [] });
    const response = await substitute({ recipeId: await insertRecipe(userId), ...fields }, llm, userId);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
    expect(llm).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('answers 404 for another user’s recipe', async () => {
    const recipeId = await insertRecipe(await insertUser('dana'));
    const response = await substitute({ recipeId, from: 'en', index: 0, lang: 'en' }, answering({ substitutes: [] }), await insertUser('noa'));
    expect(response.status).toBe(404);
  });

  it('answers 502 bad_result for an answer with no list', async () => {
    const userId = await insertUser();
    const response = await substitute({ recipeId: await insertRecipe(userId), from: 'en', index: 0, lang: 'en' }, answering({ ideas: 'oil' }), userId);
    expect(response.status).toBe(502);
    expect((await rows())[0]).toMatchObject({ status: 'failed', error: 'bad_result', model: SMALL });
  });

  it('answers 503 model_busy when its model is busy', async () => {
    const userId = await insertUser();
    const response = await substitute({ recipeId: await insertRecipe(userId), from: 'en', index: 0, lang: 'en' }, answering(new ModelBusyError('busy')), userId);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('model_busy');
  });
});
