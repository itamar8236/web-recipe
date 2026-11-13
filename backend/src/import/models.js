// Which model an import uses, and the app's own count of what's left. Quota belongs to
// the whole Google project, so all of this is shared between users, apart from each
// user's daily best-model uses.

import { ImportError } from './errors.js';
import { ModelBusyError, QuotaError } from './llm.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const limits = (env) => ({
  bestDaily: Number(env.LLM_BEST_DAILY_LIMIT),
  basicDaily: Number(env.LLM_BASIC_DAILY_LIMIT),
  bestPerUser: Number(env.IMPORT_BEST_DAILY_PER_USER),
});

// ---- Google's day ----
// Requests-per-day quotas reset at midnight Pacific, so a "day" here is a Pacific date.

const pacificClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function pacificParts(ms) {
  const parts = Object.fromEntries(pacificClock.formatToParts(ms).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function quotaDay(now) {
  const { year, month, day } = pacificParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// How far Pacific wall-clock time is ahead of UTC at the moment `ms`.
function pacificOffset(ms) {
  const { year, month, day, hour, minute, second } = pacificParts(ms);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000;
}

// The next midnight Pacific, in epoch ms. Pacific midnight is 7 or 8 hours after UTC midnight
// of the same date, so 8 hours past that lands at or just after it. The offset is read
// there, not now, because the clocks may change first (at 02:00, never at midnight).
export function nextQuotaReset(now) {
  const { year, month, day } = pacificParts(now);
  const midnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const eightHours = 8 * 60 * 60 * 1000;
  return midnightAsUtc - pacificOffset(midnightAsUtc + eightHours);
}

// ---- Counting ----

// Takes one request from the day's count, in one statement, so two imports can't both
// take the last one. False means the limit is reached and no request may be sent.
export async function reserveCall(env, model, limit, day = quotaDay(Date.now())) {
  const row = await env.DB.prepare(
    `INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, 1)
     ON CONFLICT (day, model) DO UPDATE SET calls = calls + 1 WHERE calls < ?
     RETURNING calls`,
  )
    .bind(day, model, limit)
    .first();
  return row !== null;
}

// Gives back a reserved request that Google didn't count.
async function releaseCall(env, model, day) {
  await env.DB.prepare('UPDATE llm_usage SET calls = calls - 1 WHERE day = ? AND model = ? AND calls > 0')
    .bind(day, model)
    .run();
}

// Google said the model's daily quota is used up. Google is the source of truth and may
// have counted requests the app didn't make, so the day's count is set to the limit: that
// alone keeps every later request off this model until the reset.
async function markModelOutForTheDay(env, model, limit, now) {
  await env.DB.prepare(
    `INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?)
     ON CONFLICT (day, model) DO UPDATE SET calls = excluded.calls`,
  )
    .bind(quotaDay(now), model, limit)
    .run();
}

// ---- What's available ----

// The `models` object the API returns, plus whether each model itself is open: the
// frontend needs only the first, the checks before starting need both. A user's daily
// best-model uses are the llm_requests rows (of every purpose) that called the best model.
export async function readModelState(env, userId, now = Date.now()) {
  const best = env.LLM_BEST_MODEL;
  const basic = env.LLM_BASIC_MODEL;
  const limit = limits(env);
  const day = quotaDay(now);
  const [usage, used] = await env.DB.batch([
    env.DB.prepare('SELECT model, calls FROM llm_usage WHERE day = ? AND model IN (?, ?)').bind(day, best, basic),
    env.DB.prepare('SELECT COUNT(*) AS n FROM llm_requests WHERE user_id = ? AND quota_day = ? AND used_best = 1').bind(userId, day),
  ]);
  const callsOf = (model) => usage.results.find((row) => row.model === model)?.calls ?? 0;

  const resetsAt = nextQuotaReset(now);
  const bestLeftToday = Math.max(0, limit.bestDaily - callsOf(best));
  const bestLeftForUser = Math.max(0, limit.bestPerUser - used.results[0].n);
  const bestAvailable = bestLeftToday > 0 && bestLeftForUser > 0;
  return {
    models: {
      bestAvailable,
      bestLeftToday,
      bestLeftForUser,
      basicModel: basic,
      // Both limits are daily, so the best model is back at the reset.
      bestAvailableAt: bestAvailable ? null : resetsAt,
      resetsAt,
    },
    basicOpen: callsOf(basic) < limit.basicDaily,
  };
}

// Why an import can't start now, or null when it can. Nobody is asked to approve the basic
// model: when the best one can't be used it is used by itself, so only both being out (or
// the basic one, when the user picked it) stops a start.
export function startRefusal(state, { basicChosen = false } = {}) {
  if (basicChosen) return state.basicOpen ? null : 'quota';
  return state.models.bestAvailable || state.basicOpen ? null : 'quota';
}

// ---- Calling ----

// Whether this row already holds one of the user's daily best-model uses for `day`. A row
// can call the model more than once (a Workflow retry, a busy wait, a second ask without
// the video); the use is taken once per row.
const holdsBestUse = (job, day) => job.used_best === 1 && job.quota_day === day;

// One of the user's daily best-model uses, taken in one statement so requests running at
// the same time can't go past the cap.
async function claimBestUse(env, job, day) {
  const row = await env.DB.prepare(
    `UPDATE llm_requests SET used_best = 1, quota_day = ?1
      WHERE id = ?2 AND status = 'running' AND attempt = ?3
        AND (SELECT COUNT(*) FROM llm_requests WHERE user_id = ?4 AND quota_day = ?1 AND used_best = 1) < ?5
      RETURNING id`,
  )
    .bind(day, job.id, job.attempt, job.user_id, limits(env).bestPerUser)
    .first();
  return row !== null;
}

// Reserves and sends a request, handling Google's quota answers. Returns { output }, or
// { out: true, sent } when the model can't be used; `sent` says whether a request went
// out before that. Quota errors stop here, because Workflow retries would only burn more
// requests. A busy answer (ModelBusyError) is thrown for the caller to handle.
async function callUnlessOut({ env, llm, model, limit, request }) {
  let sent = false;
  for (let tries = 1; ; tries++) {
    const day = quotaDay(Date.now());
    if (!(await reserveCall(env, model, limit, day))) return { out: true, sent };
    sent = true;
    try {
      return { output: await llm({ env, model, ...request }) };
    } catch (error) {
      // Google says a 503 is unrelated to quota, so its request is given back to the shared
      // count. If Google counted it after all, its per-day 429 sets the count right.
      if (error instanceof ModelBusyError) await releaseCall(env, model, day);
      if (!(error instanceof QuotaError)) throw error;
      if (error.daily) {
        await markModelOutForTheDay(env, model, limit, Date.now());
        return { out: true, sent };
      }
      // A short limit (per minute): one more try after Google's delay, then this request
      // gives up on the model. Nothing is remembered; the next request simply tries.
      if (tries === 2) return { out: true, sent };
      await sleep(error.retryDelayMs);
    }
  }
}

async function giveBackBestUse(env, job) {
  await env.DB.prepare(`UPDATE llm_requests SET used_best = 0 WHERE id = ? AND status = 'running' AND attempt = ?`)
    .bind(job.id, job.attempt)
    .run();
  job.used_best = 0;
}

// Calls the best model for this row, taking one of the user's daily uses first. The use
// stays taken once a request reached Google, even if the model was busy and the row ends
// up on the basic one: trying the best model is what the 5 count. Only when nothing was
// sent (the shared limit was already reached) is it given back.
async function callBest(job, deps, request) {
  const { env, llm } = deps;
  const day = quotaDay(Date.now());
  const alreadyCounted = holdsBestUse(job, day);
  if (!alreadyCounted) {
    if (!(await claimBestUse(env, job, day))) return { out: true };
    job.used_best = 1;
    job.quota_day = day;
  }
  const result = await callUnlessOut({ env, llm, model: env.LLM_BEST_MODEL, limit: limits(env).bestDaily, request });
  if (result.out && !result.sent && !alreadyCounted) await giveBackBestUse(env, job);
  return result;
}

async function callBasic(env, llm, request) {
  const model = env.LLM_BASIC_MODEL;
  const basic = await callUnlessOut({ env, llm, model, limit: limits(env).basicDaily, request });
  if (basic.out) throw new ImportError('quota');
  return { output: basic.output, model };
}

// How many Workflow waits a busy best model gets before the import moves to the basic one.
// Google advises a short retry first, but a busy spell can last hours.
const BEST_BUSY_RETRIES = 1;

// Sends an import's `request` ({ prompt, schema, videoUrl }): to the best model when the
// user didn't pick the basic one and the best one can be used, otherwise to the basic one,
// with no approval asked (the user has used their 5, the shared limit is reached, or the
// best one stayed busy). Returns { output, model }. Throws ImportError quota when no model
// can run, and ModelBusyError for the Workflow to wait and try again. `deps.busyWaits` is
// how many busy waits this stage has had.
export async function callChosenModel(job, deps, request) {
  const { env, llm, busyWaits = 0 } = deps;
  // Reaching more waits than that means the best model was busy on its retry too.
  const bestGaveUp = busyWaits > BEST_BUSY_RETRIES;
  if (!job.state?.basicChosen && !bestGaveUp) {
    try {
      const best = await callBest(job, deps, request);
      if (!best.out) return { output: best.output, model: env.LLM_BEST_MODEL };
    } catch (error) {
      if (!(error instanceof ModelBusyError) || busyWaits < BEST_BUSY_RETRIES) throw error;
      // Still busy after its retry: the basic model is used.
    }
  }
  return callBasic(env, llm, request);
}

// A translation's request, for the row `job` (purpose 'translation'). The user waits for
// it, so nothing waits: the best model (when picked) is tried once, and if it can't be used
// or is busy the basic one answers instead, with no approval asked. A best-model try takes
// one of the user's 5 like an import's. Returns { output, model }. Throws ImportError quota
// when no model can run, and ModelBusyError when the basic model is busy.
export async function callTranslationModel(job, deps, request, choice) {
  const { env, llm } = deps;
  if (choice === 'best') {
    try {
      const best = await callBest(job, deps, request);
      if (!best.out) return { output: best.output, model: env.LLM_BEST_MODEL };
    } catch (error) {
      if (!(error instanceof ModelBusyError)) throw error;
    }
  }
  return callBasic(env, llm, request);
}
