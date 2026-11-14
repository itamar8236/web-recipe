import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { ModelBusyError, QuotaError, VideoRefusedError } from '../src/import/llm.js';
import {
  callChosenModel,
  callTranslationModel,
  nextQuotaReset,
  quotaDay,
  readModelState,
  reserveCall,
  startRefusal,
} from '../src/import/models.js';
import { insertImport, insertUser } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
// The import models, in the order they are tried.
const IMPORT = env.LLM_IMPORT_MODELS.split(',');
const [FIRST, SECOND, LAST] = IMPORT;
const LIMITS = Object.fromEntries(env.LLM_DAILY_LIMITS.split(',').map((item) => [item.slice(0, item.lastIndexOf(':')), Number(item.slice(item.lastIndexOf(':') + 1))]));
const today = () => quotaDay(Date.now());
const ANSWER = { status: 'none' };
const REQUEST = { prompt: 'p', schema: {}, videoUrl: null };

const bare429 = () => new QuotaError({ daily: false, retryDelayMs: 1 });
const daily429 = () => new QuotaError({ daily: true, retryDelayMs: 1 });
const busy = () => new ModelBusyError('Gemini 503: high demand');

const setUsage = (model, calls, day = today()) =>
  env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?) ON CONFLICT (day, model) DO UPDATE SET calls = excluded.calls').bind(day, model, calls).run();
// A model Google said is out for the day: its count is at its limit.
const markOut = (model) => setUsage(model, LIMITS[model]);
const usage = async (model, day = today()) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(day, model).first())?.calls ?? 0;

let videoNumber = 0;
const newJob = (userId, fields = {}) =>
  insertImport(userId, { source_id: `video${String(++videoNumber).padStart(6, '0')}`, quota_day: today(), ...fields });
const useUpBest = async (userId, count) => {
  for (let i = 0; i < count; i++) await newJob(userId, { status: 'done', used_best: 1 });
};
const usedBestCount = async (userId) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM llm_requests WHERE user_id = ? AND quota_day = ? AND used_best = 1').bind(userId, today()).first()).n;
const reload = (job) => env.DB.prepare('SELECT * FROM llm_requests WHERE id = ?').bind(job.id).first();

const answering = (...results) => {
  const queue = [...results];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
};
const run = (job, llm) => callChosenModel(job, { env, llm }, REQUEST);
const modelsUsed = (llm) => llm.mock.calls.map(([args]) => args.model);

describe('quota day and reset', () => {
  const at = (iso) => Date.parse(iso);
  const resetAfter = (iso) => new Date(nextQuotaReset(at(iso))).toISOString();

  it.each([
    ['winter, Pacific Standard Time', '2026-01-15T12:00:00Z', '2026-01-16T08:00:00.000Z'],
    ['summer, Pacific Daylight Time', '2026-07-15T12:00:00Z', '2026-07-16T07:00:00.000Z'],
    ['one second before midnight', '2026-07-16T06:59:59Z', '2026-07-16T07:00:00.000Z'],
    ['exactly at midnight, the next one', '2026-07-16T07:00:00Z', '2026-07-17T07:00:00.000Z'],
    ['the day before clocks go forward', '2026-03-07T20:00:00Z', '2026-03-08T08:00:00.000Z'],
    ['the day clocks go forward', '2026-03-08T20:00:00Z', '2026-03-09T07:00:00.000Z'],
    ['the day before clocks go back', '2026-10-31T20:00:00Z', '2026-11-01T07:00:00.000Z'],
    ['the day clocks go back', '2026-11-01T20:00:00Z', '2026-11-02T08:00:00.000Z'],
    ['the small hours before clocks go forward', '2026-03-08T09:30:00Z', '2026-03-09T07:00:00.000Z'],
    ['the small hours before clocks go back', '2026-11-01T07:30:00Z', '2026-11-02T08:00:00.000Z'],
    ['inside the repeated hour', '2026-11-01T09:30:00Z', '2026-11-02T08:00:00.000Z'],
    ['the end of the year', '2026-12-31T20:00:00Z', '2027-01-01T08:00:00.000Z'],
  ])('finds the next reset: %s', (_, now, expected) => {
    expect(resetAfter(now)).toBe(expected);
  });

  it('dates the day in Pacific time, not UTC or Israel time', () => {
    expect(quotaDay(at('2026-07-16T06:59:59Z'))).toBe('2026-07-15');
    expect(quotaDay(at('2026-07-16T07:00:00Z'))).toBe('2026-07-16');
    expect(quotaDay(at('2026-01-05T07:59:59Z'))).toBe('2026-01-04');
  });
});

describe('the config', () => {
  it('lists the import models in order, the translation models, the best and the fallback model', () => {
    expect(IMPORT).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    expect(env.LLM_TRANSLATE_MODELS).toBe('gemini-3.5-flash-lite');
    expect(BEST).toBe('gemini-4-hydrogen');
    expect(env.LLM_FALLBACK_MODEL).toBe('openai/gpt-oss-120b');
  });

  it('gives every model its own daily limit', () => {
    for (const model of [...IMPORT, BEST, env.LLM_FALLBACK_MODEL]) expect(LIMITS[model], model).toBeGreaterThan(0);
    expect(LIMITS).toMatchObject({ [FIRST]: 20, [SECOND]: 20, [LAST]: 500, [BEST]: 20 });
  });

  it('never calls a model that has no limit set', async () => {
    const testEnv = { ...env, LLM_IMPORT_MODELS: `unknown-model,${LAST}` };
    const llm = answering(ANSWER);
    const job = await newJob(await insertUser());
    expect(await callChosenModel(job, { env: testEnv, llm }, REQUEST)).toMatchObject({ model: LAST });
    expect(modelsUsed(llm)).toEqual([LAST]);
  });
});

describe('reserving a request', () => {
  it('counts each reservation and stops at the limit', async () => {
    expect(await reserveCall(env, FIRST, 2)).toBe(true);
    expect(await reserveCall(env, FIRST, 2)).toBe(true);
    expect(await reserveCall(env, FIRST, 2)).toBe(false);
    expect(await usage(FIRST)).toBe(2);
  });

  it('gives the last slot to only one of two reservations at once', async () => {
    await setUsage(FIRST, 19);
    const results = await Promise.all([reserveCall(env, FIRST, 20), reserveCall(env, FIRST, 20)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await usage(FIRST)).toBe(20);
  });

  it('starts a fresh count on a new Pacific day', async () => {
    await setUsage(FIRST, 20, '2020-01-01');
    expect(await reserveCall(env, FIRST, 20)).toBe(true);
    expect(await usage(FIRST)).toBe(1);
  });

  it('keeps a failed call counted, because Google may have counted it', async () => {
    const job = await newJob(await insertUser());
    const llm = answering(new ImportError('llm_error', { retryable: true }));
    await expect(run(job, llm)).rejects.toMatchObject({ code: 'llm_error', retryable: true });
    expect(modelsUsed(llm)).toEqual([FIRST]);
    expect(await usage(FIRST)).toBe(1);
  });
});

describe('an import: the models are tried in order, and nobody is asked', () => {
  it('uses the first model, and none of the user’s best-model uses', async () => {
    const job = await newJob(await insertUser());
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: FIRST });
    expect(modelsUsed(llm)).toEqual([FIRST]);
    expect(await usage(FIRST)).toBe(1);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('never tries the best model unless the user asked for it', async () => {
    const llm = answering(busy(), busy(), ANSWER);
    await run(await newJob(await insertUser()), llm);
    expect(modelsUsed(llm)).not.toContain(BEST);
  });

  it('skips a model that is out for the day, sending it nothing', async () => {
    await markOut(FIRST);
    const llm = answering(ANSWER);
    expect(await run(await newJob(await insertUser()), llm)).toMatchObject({ model: SECOND });
    expect(modelsUsed(llm)).toEqual([SECOND]);
  });

  it('moves on from a busy model at once, giving its request back to the count', async () => {
    const llm = answering(busy(), ANSWER);
    expect(await run(await newJob(await insertUser()), llm)).toEqual({ output: ANSWER, model: SECOND });
    expect(modelsUsed(llm)).toEqual([FIRST, SECOND]);
    expect(await usage(FIRST)).toBe(0);
    expect(await usage(SECOND)).toBe(1);
  });

  it('reaches the last model when the two before it are busy or out', async () => {
    await markOut(SECOND);
    const llm = answering(busy(), ANSWER);
    expect(await run(await newJob(await insertUser()), llm)).toMatchObject({ model: LAST });
    expect(modelsUsed(llm)).toEqual([FIRST, LAST]);
  });

  it('reports busy when every model was busy, for the Workflow to wait, with nothing counted', async () => {
    const llm = answering(busy());
    await expect(run(await newJob(await insertUser()), llm)).rejects.toBeInstanceOf(ModelBusyError);
    expect(modelsUsed(llm)).toEqual(IMPORT);
    for (const model of IMPORT) expect(await usage(model)).toBe(0);
  });

  it('reports busy, not quota, when some models are out and the rest are busy', async () => {
    await markOut(FIRST);
    await markOut(SECOND);
    await expect(run(await newJob(await insertUser()), answering(busy()))).rejects.toBeInstanceOf(ModelBusyError);
  });

  it('fails with quota when every model is out, calling nothing', async () => {
    for (const model of IMPORT) await markOut(model);
    const llm = answering(ANSWER);
    await expect(run(await newJob(await insertUser()), llm)).rejects.toMatchObject({ code: 'quota', retryable: false });
    expect(llm).not.toHaveBeenCalled();
  });

  it('after the reset the first model is used again', async () => {
    await setUsage(FIRST, 20, '2020-01-01');
    expect(await run(await newJob(await insertUser()), answering(ANSWER))).toMatchObject({ model: FIRST });
  });

  it('a re-scan follows the same order', async () => {
    const llm = answering(busy(), ANSWER);
    expect(await run(await newJob(await insertUser(), { replace_recipe_id: 12345 }), llm)).toMatchObject({ model: SECOND });
  });

  it('passes a refused video on to the stage, without trying another model', async () => {
    const llm = answering(new VideoRefusedError());
    await expect(run(await newJob(await insertUser()), llm)).rejects.toBeInstanceOf(VideoRefusedError);
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe('quota answers from Google', () => {
  it('a daily 429 sets the day’s count to the limit and moves to the next model', async () => {
    const llm = answering(daily429(), ANSWER);
    expect(await run(await newJob(await insertUser()), llm)).toEqual({ output: ANSWER, model: SECOND });
    expect(modelsUsed(llm)).toEqual([FIRST, SECOND]);
    expect(await usage(FIRST)).toBe(20);
  });

  it('after a daily 429, the next import skips that model', async () => {
    const userId = await insertUser();
    await run(await newJob(userId), answering(daily429(), ANSWER));
    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: SECOND });
    expect(modelsUsed(llm)).toEqual([SECOND]);
  });

  it('a short (per-minute) 429 moves on at once like a busy model, remembering nothing', async () => {
    const userId = await insertUser();
    const llm = answering(bare429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: SECOND });
    expect(modelsUsed(llm)).toEqual([FIRST, SECOND]);
    expect(await usage(FIRST)).toBe(0);
    expect(await run(await newJob(userId), answering(ANSWER))).toMatchObject({ model: FIRST });
  });

  it('reports busy when every model answers a short 429', async () => {
    await expect(run(await newJob(await insertUser()), answering(bare429()))).rejects.toBeInstanceOf(ModelBusyError);
  });

  it('fails with quota when every model answers a daily 429', async () => {
    const llm = answering(daily429());
    await expect(run(await newJob(await insertUser()), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(modelsUsed(llm)).toEqual(IMPORT);
  });
});

describe('when the user asked for the best model', () => {
  const bestJob = async (userId, fields) => ({ ...(await newJob(userId, fields)), state: { bestChosen: true } });

  it('uses it, taking one of the user’s 5', async () => {
    const job = await bestJob(await insertUser());
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BEST });
    expect(modelsUsed(llm)).toEqual([BEST]);
    expect(await usage(BEST)).toBe(1);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('goes on with the import models at once when it is busy, and the try still counts', async () => {
    const job = await bestJob(await insertUser());
    const llm = answering(busy(), ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: FIRST });
    expect(modelsUsed(llm)).toEqual([BEST, FIRST]);
    expect(await usage(BEST)).toBe(0);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('goes on with the import models when it is out for the day, taking no use and sending it nothing', async () => {
    await markOut(BEST);
    const job = await bestJob(await insertUser());
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toMatchObject({ model: FIRST });
    expect(modelsUsed(llm)).toEqual([FIRST]);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('goes on with the import models when the user has used their 5', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const llm = answering(ANSWER);
    expect(await run(await bestJob(userId), llm)).toMatchObject({ model: FIRST });
    expect(modelsUsed(llm)).toEqual([FIRST]);
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('a daily 429 from it marks it out, keeps the use, and the import goes on', async () => {
    const job = await bestJob(await insertUser());
    const llm = answering(daily429(), ANSWER);
    expect(await run(job, llm)).toMatchObject({ model: FIRST });
    expect(await usage(BEST)).toBe(20);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('reports busy when it and every import model are busy', async () => {
    const llm = answering(busy());
    await expect(run(await bestJob(await insertUser()), llm)).rejects.toBeInstanceOf(ModelBusyError);
    expect(modelsUsed(llm)).toEqual([BEST, ...IMPORT]);
  });

  it('marks the use only once when one row calls the model twice', async () => {
    const userId = await insertUser();
    const job = await bestJob(userId);
    const llm = answering(ANSWER);
    await run(job, llm);
    await run(job, llm);
    expect(await usedBestCount(userId)).toBe(1);
    expect(await usage(BEST)).toBe(2);
  });

  it('lets only one of two requests at once take the last use', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 4);
    const [first, second] = [await bestJob(userId), await bestJob(userId)];
    const results = await Promise.all([run(first, answering(ANSWER)), run(second, answering(ANSWER))]);
    expect(results.map((result) => result.model).sort()).toEqual([FIRST, BEST].sort());
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('counts each user’s 5 separately', async () => {
    await useUpBest(await insertUser('dana'), 5);
    expect(await run(await bestJob(await insertUser('noa')), answering(ANSWER))).toMatchObject({ model: BEST });
  });
});

describe('a translation', () => {
  const translateWith = (llm, testEnv = env) => callTranslationModel({ env: testEnv, llm }, { prompt: 'p', schema: {} });

  it('uses the small model, never the stronger ones', async () => {
    const llm = answering(ANSWER);
    expect(await translateWith(llm)).toEqual({ output: ANSWER, model: LAST });
    expect(modelsUsed(llm)).toEqual([LAST]);
    expect(await usage(LAST)).toBe(1);
  });

  it('tries its models in order when there are several', async () => {
    const llm = answering(busy(), ANSWER);
    expect(await translateWith(llm, { ...env, LLM_TRANSLATE_MODELS: `${LAST},${SECOND}` })).toMatchObject({ model: SECOND });
  });

  it('throws ModelBusyError when its model is busy, and quota when it is out', async () => {
    await expect(translateWith(answering(busy()))).rejects.toBeInstanceOf(ModelBusyError);
    await markOut(LAST);
    await expect(translateWith(answering(ANSWER))).rejects.toMatchObject({ code: 'quota' });
  });
});

describe('what the API reports and the checks before starting', () => {
  const stateFor = (userId) => readModelState(env, userId);

  it('reports a fresh day', async () => {
    const userId = await insertUser();
    const now = Date.now();
    const { models, importModelOpen } = await readModelState(env, userId, now);
    expect(models).toEqual({
      bestAvailable: true,
      bestLeftToday: 20,
      bestLeftForUser: 5,
      bestAvailableAt: null,
      resetsAt: nextQuotaReset(now),
    });
    expect(importModelOpen).toBe(true);
  });

  it('subtracts what was used', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 3);
    await useUpBest(userId, 2);
    expect((await stateFor(userId)).models).toMatchObject({ bestAvailable: true, bestLeftToday: 17, bestLeftForUser: 3 });
  });

  it('counts translation rows from before the choice was removed toward the 5 too', async () => {
    const userId = await insertUser();
    await insertImport(userId, { purpose: 'translation', platform: null, source_id: null, source_url: null, quota_day: today(), used_best: 1 });
    expect((await stateFor(userId)).models.bestLeftForUser).toBe(4);
  });

  it('says the best model is unavailable until the reset when the user has used their 5', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const now = Date.now();
    const { models } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftForUser: 0, bestAvailableAt: nextQuotaReset(now) });
  });

  it('says the best model is unavailable until the reset when its shared count is used up', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    const now = Date.now();
    const { models } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftToday: 0, bestAvailableAt: nextQuotaReset(now) });
  });

  it('says an import can run while any import model has requests left', async () => {
    const userId = await insertUser();
    await markOut(FIRST);
    await markOut(SECOND);
    expect((await stateFor(userId)).importModelOpen).toBe(true);
    await markOut(LAST);
    expect((await stateFor(userId)).importModelOpen).toBe(false);
  });

  describe('startRefusal', () => {
    const state = (importModelOpen, bestAvailable = true) => ({ models: { bestAvailable }, importModelOpen });

    it('allows a start while an import model can run', () => {
      expect(startRefusal(state(true))).toBeNull();
      expect(startRefusal(state(true, false), { bestChosen: true })).toBeNull();
    });

    it('says quota when every import model is out', () => {
      expect(startRefusal(state(false))).toBe('quota');
      expect(startRefusal(state(false, false), { bestChosen: true })).toBe('quota');
    });

    it('still allows a start on the best model the user asked for', () => {
      expect(startRefusal(state(false, true), { bestChosen: true })).toBeNull();
    });
  });
});
