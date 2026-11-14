import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { ModelBusyError } from '../src/import/llm.js';
import { quotaDay, readModelState } from '../src/import/models.js';
import { handleTranslate } from '../src/translate.js';
import { call, cookiesFrom, insertImport, insertUser, register } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
// The one model translations are sent to (before the fallback model).
const SMALL = env.LLM_TRANSLATE_MODELS;
const today = () => quotaDay(Date.now());

const SOURCE = { name: 'Tea', ingredients: ['1 cup water', 'Tea leaves'], steps: ['Boil the water', 'Steep 3 minutes'] };
const HEBREW = { name: 'תה', ingredients: ['כוס מים', 'עלי תה'], steps: ['מרתיחים את המים', 'משרים 3 דקות'] };

// Answers each call with the next result; the last one repeats.
const answering = (...results) => {
  const queue = [...results];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
};
const modelsUsed = (llm) => llm.mock.calls.map(([args]) => args.model);

const translate = async (body, llm, userId) =>
  handleTranslate(
    new Request('http://localhost/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
    '/api/translate',
    userId ?? (await insertUser()),
    llm,
  );
const translationRows = async () =>
  (await env.DB.prepare(`SELECT * FROM llm_requests WHERE purpose = 'translation' ORDER BY id`).all()).results;
const useUpBestImports = async (userId, count) => {
  for (let i = 0; i < count; i++) {
    await insertImport(userId, { source_id: `video${String(i).padStart(6, '0')}`, status: 'done', used_best: 1, quota_day: today() });
  }
};
const insertRecipe = async (userId) =>
  (await env.DB.prepare(`INSERT INTO recipes (user_id, name_en) VALUES (?, 'Tea') RETURNING id`).bind(userId).first()).id;
const usage = async (model) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(today(), model).first())?.calls ?? 0;
// A model Google said is out for the day: its count is at its limit.
const markOut = (model) => env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, 100000)').bind(today(), model).run();

describe('POST /api/translate', () => {
  it('needs a session', async () => {
    const response = await call('/api/translate', { method: 'POST', body: { from: 'en', content: SOURCE } });
    expect(response.status).toBe(401);
  });

  it('answers 405 for another method when logged in', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/translate', { cookie })).status).toBe(405);
  });

  it('translates on the small model, records the request and its model, and stores no recipe text', async () => {
    const userId = await insertUser();
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: SOURCE }, llm, userId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: HEBREW });
    const [args] = llm.mock.calls[0];
    expect(args).toMatchObject({ model: SMALL, logPrompt: false });
    expect(args.prompt).toContain('from English to Hebrew');
    expect(args.prompt).toContain('Steep 3 minutes');
    expect(await usage(SMALL)).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM recipes').first()).n).toBe(0);
    const [row] = await translationRows();
    expect(row).toMatchObject({ user_id: userId, status: 'done', used_best: 0, recipe_id: null, source_url: null, quota_day: today() });
    expect(row.model).toBe(SMALL);
    expect(row.state).toBe('{}');
  });

  it('links the request to the recipe being edited', async () => {
    const userId = await insertUser();
    const recipeId = await insertRecipe(userId);
    expect((await translate({ from: 'en', content: SOURCE, recipeId }, answering(HEBREW), userId)).status).toBe(200);
    expect((await translationRows())[0].recipe_id).toBe(recipeId);
  });

  it('answers 404 for another user’s recipe, calling nothing', async () => {
    const recipeId = await insertRecipe(await insertUser('dana'));
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: SOURCE, recipeId }, llm, await insertUser('noa'));
    expect(response.status).toBe(404);
    expect(llm).not.toHaveBeenCalled();
    expect(await translationRows()).toEqual([]);
  });

  it('translates Hebrew to English', async () => {
    const llm = answering(SOURCE);
    const response = await translate({ from: 'he', content: HEBREW }, llm);
    expect(await response.json()).toEqual({ content: SOURCE });
    expect(llm.mock.calls[0][0].prompt).toContain('from Hebrew to English');
  });

  it('has no model choice: it never uses the best model or any of the user’s 5', async () => {
    const userId = await insertUser();
    await useUpBestImports(userId, 3);
    const llm = answering(HEBREW);
    // What a page from before the choice was removed may still send is ignored.
    for (const model of ['best', 'basic', 'great']) {
      expect((await translate({ from: 'en', content: SOURCE, model }, llm, userId)).status).toBe(200);
    }
    expect(modelsUsed(llm)).toEqual([SMALL, SMALL, SMALL]);
    expect(await usage(BEST)).toBe(0);
    expect((await translationRows()).map((row) => row.used_best)).toEqual([0, 0, 0]);
    expect((await readModelState(env, userId)).models.bestLeftForUser).toBe(2);
  });

  it('keeps which model answered even when its answer was unusable', async () => {
    await translate({ from: 'en', content: SOURCE }, answering({ text: 'hi' }));
    expect((await translationRows())[0]).toMatchObject({ status: 'failed', error: 'bad_result', model: SMALL });
  });

  it.each([
    ['no from', { content: SOURCE }],
    ['an unknown language', { from: 'fr', content: SOURCE }],
    ['an inherited key as the language', { from: 'constructor', content: SOURCE }],
    ['no content', { from: 'en' }],
    ['lines that are not text', { from: 'en', content: { name: 'Tea', ingredients: [1], steps: [] } }],
    ['a recipe id that is not a number', { from: 'en', content: SOURCE, recipeId: '5' }],
  ])('answers 400 invalid_request for %s, recording nothing', async (_, body) => {
    const llm = answering(HEBREW);
    const response = await translate(body, llm);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
    expect(llm).not.toHaveBeenCalled();
    expect(await translationRows()).toEqual([]);
  });

  it('answers 400 nothing_to_translate for an empty recipe', async () => {
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: { name: ' ', ingredients: [''], steps: [] } }, llm);
    expect((await response.json()).error).toBe('nothing_to_translate');
    expect(llm).not.toHaveBeenCalled();
  });

  it.each([
    ['not a recipe', { text: 'hi' }],
    ['a dropped part', { ...HEBREW, steps: [] }],
    ['a dropped name', { ...HEBREW, name: '' }],
  ])('answers 502 bad_result for an answer with %s', async (_, output) => {
    const response = await translate({ from: 'en', content: SOURCE }, answering(output));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('bad_result');
  });

  it('answers 503 model_busy and gives the request back when its model is busy', async () => {
    const response = await translate({ from: 'en', content: SOURCE }, answering(new ModelBusyError('busy')));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('model_busy');
    expect(await usage(SMALL)).toBe(0);
    expect((await translationRows())[0]).toMatchObject({ status: 'failed', error: 'model_busy', model: null });
  });

  it('answers 502 llm_error for another failure', async () => {
    const response = await translate({ from: 'en', content: SOURCE }, answering(new ImportError('llm_error', { retryable: true })));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('llm_error');
  });

  it('answers 429 quota when no model can run', async () => {
    await markOut(SMALL);
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: SOURCE }, llm);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('quota');
    expect(llm).not.toHaveBeenCalled();
  });
});
