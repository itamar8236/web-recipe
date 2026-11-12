import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { ModelBusyError } from '../src/import/llm.js';
import { quotaDay, readModelState } from '../src/import/models.js';
import { handleTranslate } from '../src/translate.js';
import { call, cookiesFrom, insertImport, insertUser, register } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
const BASIC = env.LLM_BASIC_MODEL;
const today = () => quotaDay(Date.now());

const SOURCE = { name: 'Tea', ingredients: ['1 cup water', 'Tea leaves'], steps: ['Boil the water', 'Steep 3 minutes'] };
const HEBREW = { name: 'תה', ingredients: ['כוס מים', 'עלי תה'], steps: ['מרתיחים את המים', 'משרים 3 דקות'] };

const answering = (result) =>
  vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });

const translate = async (body, llm, userId) =>
  handleTranslate(
    new Request('http://localhost/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
    '/api/translate',
    userId ?? (await insertUser()),
    llm,
  );
const bestUses = async (userId) =>
  (await env.DB.prepare('SELECT uses FROM translation_best_uses WHERE user_id = ? AND day = ?').bind(userId, today()).first())?.uses ?? 0;
const useUpBestImports = async (userId, count) => {
  for (let i = 0; i < count; i++) {
    await insertImport(userId, { source_id: `video${String(i).padStart(6, '0')}`, status: 'done', used_best: 1, quota_day: today() });
  }
};
const usage = async (model) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(today(), model).first())?.calls ?? 0;
const markOut = (model) =>
  env.DB.prepare('INSERT INTO llm_model_status (model, unavailable_until) VALUES (?, ?)').bind(model, Date.now() + 3600000).run();

describe('POST /api/translate', () => {
  it('needs a session', async () => {
    const response = await call('/api/translate', { method: 'POST', body: { from: 'en', content: SOURCE } });
    expect(response.status).toBe(401);
  });

  it('answers 405 for another method when logged in', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/translate', { cookie })).status).toBe(405);
  });

  it('translates to the other language on the basic model by default, and stores nothing', async () => {
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: SOURCE }, llm);
    expect(response.status).toBe(200);
    expect((await response.json()).content).toEqual(HEBREW);
    const [args] = llm.mock.calls[0];
    expect(args).toMatchObject({ model: BASIC, logPrompt: false });
    expect(args.prompt).toContain('from English to Hebrew');
    expect(args.prompt).toContain('Steep 3 minutes');
    expect(await usage(BASIC)).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM recipes').first()).n).toBe(0);
  });

  it('uses the best model when picked, and translates Hebrew to English', async () => {
    const llm = answering(SOURCE);
    expect((await translate({ from: 'he', content: HEBREW, model: 'best' }, llm)).status).toBe(200);
    expect(llm.mock.calls[0][0].model).toBe(BEST);
    expect(llm.mock.calls[0][0].prompt).toContain('from Hebrew to English');
  });

  describe('the user’s 5 daily best-model uses', () => {
    it('a best-model translation takes one, and the import checks see it', async () => {
      const userId = await insertUser();
      await useUpBestImports(userId, 3);
      await translate({ from: 'en', content: SOURCE, model: 'best' }, answering(HEBREW), userId);
      expect(await bestUses(userId)).toBe(1);
      expect((await readModelState(env, userId)).models.bestLeftForUser).toBe(1);
    });

    it('a basic-model translation takes none', async () => {
      const userId = await insertUser();
      await translate({ from: 'en', content: SOURCE }, answering(HEBREW), userId);
      expect(await bestUses(userId)).toBe(0);
    });

    it('answers best_model_unavailable at 5, counting imports and translations, without calling the model', async () => {
      const userId = await insertUser();
      await useUpBestImports(userId, 4);
      expect((await translate({ from: 'en', content: SOURCE, model: 'best' }, answering(HEBREW), userId)).status).toBe(200);
      const llm = answering(HEBREW);
      const response = await translate({ from: 'en', content: SOURCE, model: 'best' }, llm, userId);
      expect(response.status).toBe(429);
      expect((await response.json()).error).toBe('best_model_unavailable');
      expect(llm).not.toHaveBeenCalled();
      expect(await bestUses(userId)).toBe(1);
      expect((await readModelState(env, userId)).models.bestAvailable).toBe(false);
    });

    it('gives the use back when the model is busy or nothing was sent', async () => {
      const userId = await insertUser();
      await translate({ from: 'en', content: SOURCE, model: 'best' }, answering(new ModelBusyError('busy')), userId);
      expect(await bestUses(userId)).toBe(0);
      await markOut(BEST);
      await translate({ from: 'en', content: SOURCE, model: 'best' }, answering(HEBREW), userId);
      expect(await bestUses(userId)).toBe(0);
    });

    it('keeps the use when Google answered, even with a bad result', async () => {
      const userId = await insertUser();
      await translate({ from: 'en', content: SOURCE, model: 'best' }, answering({ text: 'hi' }), userId);
      expect(await bestUses(userId)).toBe(1);
    });
  });

  it.each([
    ['no from', { content: SOURCE }],
    ['an unknown language', { from: 'fr', content: SOURCE }],
    ['an inherited key as the language', { from: 'constructor', content: SOURCE }],
    ['an unknown model', { from: 'en', content: SOURCE, model: 'great' }],
    ['no content', { from: 'en' }],
    ['lines that are not text', { from: 'en', content: { name: 'Tea', ingredients: [1], steps: [] } }],
  ])('answers 400 invalid_request for %s', async (_, body) => {
    const llm = answering(HEBREW);
    const response = await translate(body, llm);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
    expect(llm).not.toHaveBeenCalled();
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

  it('answers 503 model_busy and gives the request back when the model is busy', async () => {
    const response = await translate({ from: 'en', content: SOURCE }, answering(new ModelBusyError('busy')));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('model_busy');
    expect(await usage(BASIC)).toBe(0);
  });

  it('answers 502 llm_error for another failure', async () => {
    const response = await translate({ from: 'en', content: SOURCE }, answering(new ImportError('llm_error', { retryable: true })));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('llm_error');
  });

  it('answers 429 best_model_unavailable when the best model is out, without calling it', async () => {
    await markOut(BEST);
    const llm = answering(HEBREW);
    const response = await translate({ from: 'en', content: SOURCE, model: 'best' }, llm);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('best_model_unavailable');
    expect(llm).not.toHaveBeenCalled();
  });

  it('answers 429 quota when the basic model is out', async () => {
    await markOut(BASIC);
    const response = await translate({ from: 'en', content: SOURCE }, answering(HEBREW));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('quota');
  });
});
