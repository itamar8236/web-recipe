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
const BASIC = env.LLM_BASIC_MODEL;
const today = () => quotaDay(Date.now());
const ANSWER = { status: 'none' };

const bare429 = () => new QuotaError({ daily: false, retryDelayMs: 1 });
const daily429 = () => new QuotaError({ daily: true, retryDelayMs: 1 });

const setUsage = (model, calls, day = today()) =>
  env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?) ON CONFLICT (day, model) DO UPDATE SET calls = excluded.calls').bind(day, model, calls).run();
// A model Google said is out for the day: its count is at its limit.
const markOut = (model) => setUsage(model, model === BEST ? 20 : 500);
const usage = async (model, day = today()) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(day, model).first())?.calls ?? 0;

let videoNumber = 0;
const newJob = (userId, fields = {}) =>
  insertImport(userId, { source_id: `video${String(++videoNumber).padStart(6, '0')}`, quota_day: today(), ...fields });
const useUpBest = async (userId, count) => {
  for (let i = 0; i < count; i++) await newJob(userId, { status: 'done', used_best: 1 });
};
const usedBestCount = async (userId) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM imports WHERE user_id = ? AND quota_day = ? AND used_best = 1').bind(userId, today()).first()).n;
const reload = (job) => env.DB.prepare('SELECT * FROM imports WHERE id = ?').bind(job.id).first();

const answering = (...results) => {
  const queue = [...results];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
};
const run = (job, llm) => callChosenModel(job, { env, llm }, { prompt: 'p', schema: {}, videoUrl: null });
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

describe('reserving a request', () => {
  it('counts each reservation and stops at the limit', async () => {
    expect(await reserveCall(env, BEST, 2)).toBe(true);
    expect(await reserveCall(env, BEST, 2)).toBe(true);
    expect(await reserveCall(env, BEST, 2)).toBe(false);
    expect(await usage(BEST)).toBe(2);
  });

  it('gives the last slot to only one of two reservations at once', async () => {
    await setUsage(BEST, 19);
    const results = await Promise.all([reserveCall(env, BEST, 20), reserveCall(env, BEST, 20)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await usage(BEST)).toBe(20);
  });

  it('starts a fresh count on a new Pacific day', async () => {
    await setUsage(BEST, 20, '2020-01-01');
    expect(await reserveCall(env, BEST, 20)).toBe(true);
    expect(await usage(BEST)).toBe(1);
  });

  it('sends no best-model request when its limit is already reached, and takes no use', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20);
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('keeps a failed call counted, because Google may have counted it', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(new ImportError('llm_error', { retryable: true }));
    await expect(run(job, llm)).rejects.toMatchObject({ code: 'llm_error', retryable: true });
    expect(await usage(BEST)).toBe(1);
    expect((await reload(job)).used_best).toBe(1);
  });
});

describe('the model policy: no approval is ever asked', () => {
  it('best available, user under their 5: uses the best model', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BEST });
    expect(modelsUsed(llm)).toEqual([BEST]);
    expect(await usage(BEST)).toBe(1);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('best out for the day: uses the basic model by itself', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('user at 5 (the 6th import): uses the basic model by itself', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('both out: fails with quota, calling nothing', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    await markOut(BASIC);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'quota', retryable: false });
    expect(llm).not.toHaveBeenCalled();
  });

  it('after the reset: the best model is used again by itself', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20, '2020-01-01');
    expect(await run(await newJob(userId), answering(ANSWER))).toMatchObject({ model: BEST });
  });

  it('counts each user’s 5 separately', async () => {
    const dana = await insertUser('dana');
    const noa = await insertUser('noa');
    await useUpBest(dana, 5);
    expect(await run(await newJob(noa), answering(ANSWER))).toMatchObject({ model: BEST });
  });
});

describe('quota answers from Google', () => {
  it('a daily 429 sets the day’s count to the limit and moves to the basic model in the same stage', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(daily429(), ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
    expect(await usage(BEST)).toBe(20);
    // A request reached the best model, so the try counts.
    expect((await reload(job)).used_best).toBe(1);
  });

  it('after a daily 429, the next import goes straight to the basic model', async () => {
    const userId = await insertUser();
    await run(await newJob(userId), answering(daily429(), ANSWER));
    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
  });

  it('a bare 429 waits and retries once, reserving again, and can succeed', async () => {
    const userId = await insertUser();
    const llm = answering(bare429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BEST });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(await usage(BEST)).toBe(2);
  });

  it('two bare 429s move this import to the basic model, remembering nothing', async () => {
    const userId = await insertUser();
    const llm = answering(bare429(), bare429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BEST, BASIC]);
    expect(await usage(BEST)).toBe(2);
    const next = answering(ANSWER);
    expect(await run(await newJob(userId), next)).toMatchObject({ model: BEST });
  });

  it('stops retrying when the last slot went to someone else in the meantime', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 19);
    const llm = answering(bare429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
  });

  it.each([
    ['daily', daily429],
    ['bare', bare429],
  ])('fails with quota when the basic model also answers a %s 429', async (_, error) => {
    const userId = await insertUser();
    await markOut(BEST);
    await expect(run(await newJob(userId), answering(error()))).rejects.toMatchObject({ code: 'quota' });
  });

  it('passes a refused video on to the stage', async () => {
    const userId = await insertUser();
    await expect(run(await newJob(userId), answering(new VideoRefusedError()))).rejects.toBeInstanceOf(VideoRefusedError);
  });
});

describe('each user’s 5 best-model uses', () => {
  it('marks the use only once when one row calls the model twice', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    await run(job, llm);
    await run(job, llm);
    expect(await usedBestCount(userId)).toBe(1);
    expect(await usage(BEST)).toBe(2);
  });

  it('lets only one of two imports at once take the last use; the other uses the basic model', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 4);
    const [first, second] = [await newJob(userId), await newJob(userId)];
    const llm = answering(ANSWER);
    const results = await Promise.all([run(first, llm), run(second, llm)]);
    expect(results.map((r) => r.model).sort()).toEqual([BASIC, BEST].sort());
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('counts translation rows on the best model too', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 4);
    await insertImport(userId, { purpose: 'translation', platform: null, source_id: null, source_url: null, quota_day: today(), used_best: 1 });
    expect((await readModelState(env, userId)).models.bestLeftForUser).toBe(0);
    expect(await run(await newJob(userId), answering(ANSWER))).toMatchObject({ model: BASIC });
  });
});

describe('when the user chose the basic model', () => {
  const basicJob = async (userId) => ({ ...(await newJob(userId)), state: { basicChosen: true } });

  it('uses only the basic model, and none of the user’s 5', async () => {
    const userId = await insertUser();
    const job = await basicJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect(await usage(BEST)).toBe(0);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('fails with quota when the basic model is out, never trying the best one', async () => {
    const userId = await insertUser();
    await markOut(BASIC);
    const llm = answering(ANSWER);
    await expect(run(await basicJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('when the best model is busy', () => {
  const busy = () => new ModelBusyError('Gemini 503: high demand');
  // `busyWaits` is how many Workflow waits came before this run of the stage.
  const runAfterWaits = (job, llm, busyWaits) =>
    callChosenModel(job, { env, llm, busyWaits }, { prompt: 'p', schema: {}, videoUrl: null });

  it('leaves the first busy answer to a Workflow wait: the request goes back to the shared count, the user’s use stays', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(busy());
    await expect(runAfterWaits(job, llm, 0)).rejects.toBeInstanceOf(ModelBusyError);
    expect(modelsUsed(llm)).toEqual([BEST]);
    expect(await usage(BEST)).toBe(0);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('keeps the best model’s answer when it is free again on its retry, taking the use once', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    await expect(runAfterWaits(job, answering(busy()), 0)).rejects.toBeInstanceOf(ModelBusyError);
    expect(await runAfterWaits(await reload(job), answering(ANSWER), 1)).toEqual({ output: ANSWER, model: BEST });
    expect(await usedBestCount(userId)).toBe(1);
  });

  it('moves to the basic model when the best one is still busy on its retry, and the try still counts', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(busy(), ANSWER);
    expect(await runAfterWaits(job, llm, 1)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
    expect(await usage(BEST)).toBe(0);
    expect(await usage(BASIC)).toBe(1);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('goes straight to the basic model after that', async () => {
    const userId = await insertUser();
    const llm = answering(ANSWER);
    expect(await runAfterWaits(await newJob(userId), llm, 2)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
  });

  it('leaves a busy basic model to the Workflow wait too, giving back its request', async () => {
    const userId = await insertUser();
    const llm = answering(busy(), busy());
    await expect(runAfterWaits(await newJob(userId), llm, 1)).rejects.toBeInstanceOf(ModelBusyError);
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
    expect(await usage(BASIC)).toBe(0);
  });

  it('moves a re-scan to the basic model too', async () => {
    const userId = await insertUser();
    const llm = answering(busy(), ANSWER);
    expect(await runAfterWaits(await newJob(userId, { replace_recipe_id: 12345 }), llm, 1)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
  });
});

describe('a re-scan of an existing recipe', () => {
  const rescanJob = (userId, fields = {}) => newJob(userId, { replace_recipe_id: 12345, ...fields });

  it('uses the best model', async () => {
    const userId = await insertUser();
    expect(await run(await rescanJob(userId), answering(ANSWER))).toMatchObject({ model: BEST });
  });

  it('uses the basic model when the user picked it', async () => {
    const userId = await insertUser();
    const llm = answering(ANSWER);
    const job = { ...(await rescanJob(userId)), state: { basicChosen: true } };
    expect(await run(job, llm)).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
  });

  it('moves to the basic model by itself when the best one is out, like a new import', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    expect(await run(await rescanJob(userId), answering(ANSWER))).toMatchObject({ model: BASIC });
  });
});

describe('a translation', () => {
  const translationJob = (userId) =>
    insertImport(userId, { purpose: 'translation', platform: null, source_id: null, source_url: null, quota_day: today() });
  const translateWith = (job, llm, choice) => callTranslationModel(job, { env, llm }, { prompt: 'p', schema: {} }, choice);
  const busy = () => new ModelBusyError('Gemini 503: high demand');

  it('uses only the basic model when it was picked, taking none of the 5', async () => {
    const userId = await insertUser();
    const job = await translationJob(userId);
    const llm = answering(ANSWER);
    expect(await translateWith(job, llm, 'basic')).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('uses the best model when picked, taking one of the 5', async () => {
    const userId = await insertUser();
    const job = await translationJob(userId);
    expect(await translateWith(job, answering(ANSWER), 'best')).toMatchObject({ model: BEST });
    expect((await reload(job)).used_best).toBe(1);
  });

  it('answers with the basic model at once when the best one is busy, and the try counts', async () => {
    const userId = await insertUser();
    const job = await translationJob(userId);
    const llm = answering(busy(), ANSWER);
    expect(await translateWith(job, llm, 'best')).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('answers with the basic model when the user has used their 5', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const job = await translationJob(userId);
    const llm = answering(ANSWER);
    expect(await translateWith(job, llm, 'best')).toMatchObject({ model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('throws ModelBusyError when the basic model is busy, and quota when it is out', async () => {
    const userId = await insertUser();
    await expect(translateWith(await translationJob(userId), answering(busy()), 'basic')).rejects.toBeInstanceOf(ModelBusyError);
    await markOut(BASIC);
    await expect(translateWith(await translationJob(userId), answering(ANSWER), 'basic')).rejects.toMatchObject({ code: 'quota' });
  });
});

describe('what the API reports and the checks before starting', () => {
  const stateFor = (userId) => readModelState(env, userId);

  it('reports a fresh day', async () => {
    const userId = await insertUser();
    const now = Date.now();
    const { models, basicOpen } = await readModelState(env, userId, now);
    expect(models).toEqual({
      bestAvailable: true,
      bestLeftToday: 20,
      bestLeftForUser: 5,
      basicModel: BASIC,
      bestAvailableAt: null,
      resetsAt: nextQuotaReset(now),
    });
    expect(basicOpen).toBe(true);
  });

  it('subtracts what was used', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 3);
    await useUpBest(userId, 2);
    const { models } = await stateFor(userId);
    expect(models).toMatchObject({ bestAvailable: true, bestLeftToday: 17, bestLeftForUser: 3 });
  });

  it('is unavailable until the reset when the user has used their 5', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const now = Date.now();
    const { models } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftForUser: 0, bestAvailableAt: nextQuotaReset(now) });
  });

  it('is unavailable until the reset when the shared count is used up', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20);
    const now = Date.now();
    const { models } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftToday: 0, bestAvailableAt: nextQuotaReset(now) });
  });

  it('says the basic model is closed when its count is used up', async () => {
    const userId = await insertUser();
    await markOut(BASIC);
    expect((await stateFor(userId)).basicOpen).toBe(false);
  });

  describe('startRefusal', () => {
    const state = (bestAvailable, basicOpen = true) => ({ models: { bestAvailable }, basicOpen });

    it('allows a start while either model can run', () => {
      expect(startRefusal(state(true))).toBeNull();
      expect(startRefusal(state(false))).toBeNull();
      expect(startRefusal(state(true, false))).toBeNull();
    });

    it('says quota when both are out', () => {
      expect(startRefusal(state(false, false))).toBe('quota');
    });

    it('looks only at the basic model when the user picked it', () => {
      expect(startRefusal(state(true, false), { basicChosen: true })).toBe('quota');
      expect(startRefusal(state(false, true), { basicChosen: true })).toBeNull();
    });
  });
});
