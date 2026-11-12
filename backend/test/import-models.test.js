import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { QuotaError, VideoRefusedError } from '../src/import/llm.js';
import {
  callChosenModel,
  nextQuotaReset,
  quotaDay,
  readModelState,
  reserveCall,
  startRefusal,
  storeApproval,
} from '../src/import/models.js';
import { insertImport, insertUser } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
const BASIC = env.LLM_BASIC_MODEL;
const today = () => quotaDay(Date.now());
const LATER = () => Date.now() + 60 * 60 * 1000;
const EARLIER = () => Date.now() - 1000;
const ANSWER = { status: 'none' };

const bare429 = () => new QuotaError({ daily: false, retryDelayMs: 1 });
const daily429 = () => new QuotaError({ daily: true, retryDelayMs: 1 });

const setUsage = (model, calls, day = today()) =>
  env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?)').bind(day, model, calls).run();
const usage = async (model, day = today()) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(day, model).first())?.calls ?? 0;
const markOut = (model, until = LATER()) =>
  env.DB.prepare('INSERT INTO llm_model_status (model, unavailable_until) VALUES (?, ?)').bind(model, until).run();
const outUntil = async (model) =>
  (await env.DB.prepare('SELECT unavailable_until AS t FROM llm_model_status WHERE model = ?').bind(model).first())?.t ?? null;
const approve = (userId, until = LATER()) =>
  env.DB.prepare('INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, ?)').bind(userId, until).run();

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

  it('sends no request when the limit is already reached', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(llm).not.toHaveBeenCalled();
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

describe('the model policy table', () => {
  it('best available, user under their 5: uses the best model', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BEST });
    expect(modelsUsed(llm)).toEqual([BEST]);
    expect(await usage(BEST)).toBe(1);
    expect((await reload(job)).used_best).toBe(1);
  });

  it('best out, user approved: uses the basic model', async () => {
    const userId = await insertUser();
    await approve(userId);
    await markOut(BEST);
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BASIC]);
    expect(await usage(BEST)).toBe(0);
    expect((await reload(job)).used_best).toBe(0);
  });

  it('user at 5, user approved: uses the basic model', async () => {
    const userId = await insertUser();
    await approve(userId);
    await useUpBest(userId, 5);
    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BASIC });
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('best out, not approved: asks, and runs nothing', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed', retryable: false });
    expect(llm).not.toHaveBeenCalled();
  });

  it('user at 5, not approved: asks, and runs nothing (the 6th import)', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 5);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(llm).not.toHaveBeenCalled();
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('both out: fails with quota, approved or not', async () => {
    const userId = await insertUser();
    await markOut(BEST);
    await markOut(BASIC);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'quota', retryable: false });
    await approve(userId);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(llm).not.toHaveBeenCalled();
  });

  it('after the reset: best is used again by itself and the approval has expired', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20, '2020-01-01');
    await markOut(BEST, EARLIER());
    await approve(userId, EARLIER());

    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BEST });

    const failing = answering(daily429());
    await expect(run(await newJob(userId), failing)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(modelsUsed(failing)).toEqual([BEST]);
  });

  it('an approved user still tries the best model first', async () => {
    const userId = await insertUser();
    await approve(userId);
    const llm = answering(ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BEST });
    expect(modelsUsed(llm)).toEqual([BEST]);
  });

  it('an approval counts only for its own user', async () => {
    const owner = await insertUser('dana');
    const other = await insertUser('noa');
    await approve(owner);
    await markOut(BEST);
    await expect(run(await newJob(other), answering(ANSWER))).rejects.toMatchObject({ code: 'model_approval_needed' });
  });
});

describe('quota answers from Google', () => {
  it('a daily 429 marks the model out until the reset and syncs the count', async () => {
    const userId = await insertUser();
    const llm = answering(daily429());
    const before = Date.now();
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(await outUntil(BEST)).toBe(nextQuotaReset(before));
    expect(await usage(BEST)).toBe(20);
  });

  it('with an approval, a daily 429 moves to the basic model in the same stage', async () => {
    const userId = await insertUser();
    await approve(userId);
    const llm = answering(daily429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toEqual({ output: ANSWER, model: BASIC });
    expect(modelsUsed(llm)).toEqual([BEST, BASIC]);
  });

  it('a bare 429 waits and retries once, reserving again, and can succeed', async () => {
    const userId = await insertUser();
    const llm = answering(bare429(), ANSWER);
    expect(await run(await newJob(userId), llm)).toMatchObject({ model: BEST });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(await usage(BEST)).toBe(2);
    expect(await outUntil(BEST)).toBeNull();
  });

  it('two bare 429s put the model on a 15-minute cool-down, without touching the count', async () => {
    const userId = await insertUser();
    const llm = answering(bare429());
    const before = Date.now();
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(llm).toHaveBeenCalledTimes(2);
    const until = await outUntil(BEST);
    expect(until).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(until).toBeLessThan(before + 16 * 60 * 1000);
    expect(await usage(BEST)).toBe(2);
  });

  it('a bare 429 then a daily 429 counts as daily', async () => {
    const userId = await insertUser();
    const before = Date.now();
    await expect(run(await newJob(userId), answering(bare429(), daily429()))).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(await outUntil(BEST)).toBe(nextQuotaReset(before));
  });

  it('stops retrying when the last slot went to someone else in the meantime', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 19);
    const llm = answering(bare429(), ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('uses the model again once the cool-down has passed', async () => {
    const userId = await insertUser();
    await markOut(BEST, EARLIER());
    expect(await run(await newJob(userId), answering(ANSWER))).toMatchObject({ model: BEST });
  });

  it.each([
    ['daily', daily429],
    ['bare', bare429],
  ])('fails with quota when the basic model also answers a %s 429', async (_, error) => {
    const userId = await insertUser();
    await approve(userId);
    await markOut(BEST);
    await expect(run(await newJob(userId), answering(error()))).rejects.toMatchObject({ code: 'quota' });
  });

  it('fails with quota, not an offer, when the basic model is out too', async () => {
    const userId = await insertUser();
    await markOut(BASIC);
    const llm = answering(daily429());
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
  });

  it('fails with quota when the basic model has reached its own limit', async () => {
    const userId = await insertUser();
    await approve(userId);
    await markOut(BEST);
    await setUsage(BASIC, 500);
    const llm = answering(ANSWER);
    await expect(run(await newJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(llm).not.toHaveBeenCalled();
  });

  it('passes a refused video on to the stage', async () => {
    const userId = await insertUser();
    await expect(run(await newJob(userId), answering(new VideoRefusedError()))).rejects.toBeInstanceOf(VideoRefusedError);
  });
});

describe('each user’s 5 best-model imports', () => {
  it('does not use another of the 5 when the same import is retried', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 4);
    const job = await newJob(userId, { used_best: 1 });
    const llm = answering(ANSWER);
    expect(await run(job, llm)).toMatchObject({ model: BEST });
    expect(await usedBestCount(userId)).toBe(5);
    expect(await usage(BEST)).toBe(1);
  });

  it('marks the use only once when one stage calls the model twice', async () => {
    const userId = await insertUser();
    const job = await newJob(userId);
    const llm = answering(ANSWER);
    await run(job, llm);
    await run(job, llm);
    expect(await usedBestCount(userId)).toBe(1);
    expect(await usage(BEST)).toBe(2);
  });

  it('takes a new use when an import from an earlier day is retried', async () => {
    const userId = await insertUser();
    const job = await newJob(userId, { used_best: 1, quota_day: '2020-01-01' });
    await run(job, answering(ANSWER));
    expect(await reload(job)).toMatchObject({ used_best: 1, quota_day: today() });
    expect(await usedBestCount(userId)).toBe(1);
  });

  it('lets only one of two imports at once take the last use', async () => {
    const userId = await insertUser();
    await useUpBest(userId, 4);
    const [first, second] = [await newJob(userId), await newJob(userId)];
    const llm = answering(ANSWER);
    const results = await Promise.allSettled([run(first, llm), run(second, llm)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'model_approval_needed' });
    expect(await usedBestCount(userId)).toBe(5);
  });

  it('gives the use back when no request went out', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20);
    const job = await newJob(userId);
    await expect(run(job, answering(ANSWER))).rejects.toMatchObject({ code: 'model_approval_needed' });
    expect((await reload(job)).used_best).toBe(0);
  });

  it('counts each user separately', async () => {
    const dana = await insertUser('dana');
    const noa = await insertUser('noa');
    await useUpBest(dana, 5);
    expect(await run(await newJob(noa), answering(ANSWER))).toMatchObject({ model: BEST });
  });
});

describe('when the user chose the basic model', () => {
  const basicJob = async (userId) => ({ ...(await newJob(userId)), state: { basicChosen: true } });

  it('uses only the basic model, with no approval and none of the user’s 5', async () => {
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

describe('a re-run', () => {
  const rerunJob = (userId) => newJob(userId, { replace_recipe_id: 12345 });

  it('uses the best model', async () => {
    const userId = await insertUser();
    expect(await run(await rerunJob(userId), answering(ANSWER))).toMatchObject({ model: BEST });
  });

  it.each([
    ['the best model is marked out', async () => markOut(BEST), 0],
    ['the shared limit is reached', async () => setUsage(BEST, 20), 0],
  ])('fails with quota when %s, even with an approval', async (_, arrange, calls) => {
    const userId = await insertUser();
    await approve(userId);
    await arrange();
    const llm = answering(ANSWER);
    await expect(run(await rerunJob(userId), llm)).rejects.toMatchObject({ code: 'quota', retryable: false });
    expect(llm).toHaveBeenCalledTimes(calls);
  });

  it('fails with quota when the user is at their 5, even with an approval', async () => {
    const userId = await insertUser();
    await approve(userId);
    await useUpBest(userId, 5);
    const llm = answering(ANSWER);
    await expect(run(await rerunJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(llm).not.toHaveBeenCalled();
  });

  it('never moves to the basic model when Google says the best one ran out', async () => {
    const userId = await insertUser();
    await approve(userId);
    const llm = answering(daily429());
    await expect(run(await rerunJob(userId), llm)).rejects.toMatchObject({ code: 'quota' });
    expect(modelsUsed(llm)).toEqual([BEST]);
    expect(await usage(BASIC)).toBe(0);
  });
});

describe('what the API reports and the checks before starting', () => {
  const stateFor = (userId) => readModelState(env, userId);

  it('reports a fresh day', async () => {
    const userId = await insertUser();
    const now = Date.now();
    const { models, bestOpen, basicOpen } = await readModelState(env, userId, now);
    expect(models).toEqual({
      bestAvailable: true,
      bestLeftToday: 20,
      bestLeftForUser: 5,
      basicModel: BASIC,
      basicApproved: false,
      bestAvailableAt: null,
      resetsAt: nextQuotaReset(now),
    });
    expect({ bestOpen, basicOpen }).toEqual({ bestOpen: true, basicOpen: true });
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
    const { models, bestOpen } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftForUser: 0, bestAvailableAt: nextQuotaReset(now) });
    expect(bestOpen).toBe(true);
  });

  it('is unavailable until the reset when the shared count is used up', async () => {
    const userId = await insertUser();
    await setUsage(BEST, 20);
    const now = Date.now();
    const { models, bestOpen } = await readModelState(env, userId, now);
    expect(models).toMatchObject({ bestAvailable: false, bestLeftToday: 0, bestAvailableAt: nextQuotaReset(now) });
    expect(bestOpen).toBe(false);
  });

  it('reports the end of a cool-down as when the best model is back', async () => {
    const userId = await insertUser();
    const until = Date.now() + 5 * 60 * 1000;
    await markOut(BEST, until);
    expect((await stateFor(userId)).models).toMatchObject({ bestAvailable: false, bestAvailableAt: until });
  });

  it('ignores a mark that has expired', async () => {
    const userId = await insertUser();
    await markOut(BEST, EARLIER());
    expect((await stateFor(userId)).models).toMatchObject({ bestAvailable: true, bestAvailableAt: null });
  });

  it('stores an approval until the next reset, for that user only', async () => {
    const userId = await insertUser('dana');
    const other = await insertUser('noa');
    const now = Date.now();
    await storeApproval(env, userId, now);
    const row = await env.DB.prepare('SELECT approved_until FROM llm_basic_model_approvals WHERE user_id = ?').bind(userId).first();
    expect(row.approved_until).toBe(nextQuotaReset(now));
    expect((await stateFor(userId)).models.basicApproved).toBe(true);
    expect((await stateFor(other)).models.basicApproved).toBe(false);
  });

  it('renews an expired approval and stops counting one that has expired', async () => {
    const userId = await insertUser();
    await approve(userId, EARLIER());
    expect((await stateFor(userId)).models.basicApproved).toBe(false);
    await storeApproval(env, userId, Date.now());
    expect((await stateFor(userId)).models.basicApproved).toBe(true);
  });

  describe('startRefusal', () => {
    const state = (models, open = {}) => ({ models, bestOpen: false, basicOpen: true, ...open });

    it('allows a start while the best model is available', () => {
      expect(startRefusal(state({ bestAvailable: true }))).toBeNull();
    });

    it('allows a start on the basic model with an approval', () => {
      expect(startRefusal(state({ bestAvailable: false, basicApproved: true }))).toBeNull();
    });

    it('asks without an approval', () => {
      expect(startRefusal(state({ bestAvailable: false, basicApproved: false }))).toBe('model_approval_needed');
    });

    it('says quota when both are out', () => {
      expect(startRefusal(state({ bestAvailable: false, basicApproved: true }, { basicOpen: false }))).toBe('quota');
      expect(startRefusal(state({ bestAvailable: false, basicApproved: false }, { basicOpen: false }))).toBe('quota');
    });

    it('never offers the basic model to a re-run', () => {
      expect(startRefusal(state({ bestAvailable: false, basicApproved: true }), { bestOnly: true })).toBe('quota');
      expect(startRefusal(state({ bestAvailable: true }), { bestOnly: true })).toBeNull();
    });

    it('lets a retry through at the user’s cap when it already holds one of the 5', () => {
      const atCap = state({ bestAvailable: false, basicApproved: false }, { bestOpen: true });
      expect(startRefusal(atCap, { countedBest: true })).toBeNull();
      expect(startRefusal(atCap)).toBe('model_approval_needed');
    });

    it('does not let that retry through when the model itself is out', () => {
      const out = state({ bestAvailable: false, basicApproved: false }, { bestOpen: false });
      expect(startRefusal(out, { countedBest: true })).toBe('model_approval_needed');
    });
  });
});
