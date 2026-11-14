// Which model answers a request, and the app's own count of what's left. Quota belongs to
// the whole Google project (and, for the fallback model, the whole Groq account), so all
// of this is shared between users, apart from each user's daily best-model uses.
//
// Users choose nothing by default. An import tries the models in LLM_IMPORT_MODELS in
// order and a translation those in LLM_TRANSLATE_MODELS, moving on at once from a model
// that is busy or out for the day, and ending on the text-only fallback model. The one
// choice a user has is the best model (LLM_BEST_MODEL), slower and more detailed, a few
// times a day each.

import { ImportError } from './errors.js';
import { callFallbackModel } from './groq.js';
import { ModelBusyError, QuotaError } from './llm.js';

const list = (text) =>
  String(text ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// LLM_DAILY_LIMITS is "model:limit,model:limit". A model that isn't in it is never called.
function dailyLimit(env, model) {
  const entry = list(env.LLM_DAILY_LIMITS).find((item) => item.slice(0, item.lastIndexOf(':')) === model);
  return entry ? Number(entry.slice(entry.lastIndexOf(':') + 1)) : 0;
}

const importModels = (env) => list(env.LLM_IMPORT_MODELS);

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

// The `models` object the API returns, plus whether an import can run at all: the frontend
// needs only the first, the checks before starting need both. A user's daily best-model
// uses are the llm_requests rows that called the best model.
export async function readModelState(env, userId, now = Date.now()) {
  const best = env.LLM_BEST_MODEL;
  const day = quotaDay(now);
  const [usage, used] = await env.DB.batch([
    env.DB.prepare('SELECT model, calls FROM llm_usage WHERE day = ?').bind(day),
    env.DB.prepare('SELECT COUNT(*) AS n FROM llm_requests WHERE user_id = ? AND quota_day = ? AND used_best = 1').bind(userId, day),
  ]);
  const callsOf = (model) => usage.results.find((row) => row.model === model)?.calls ?? 0;

  const resetsAt = nextQuotaReset(now);
  const bestLeftToday = Math.max(0, dailyLimit(env, best) - callsOf(best));
  const bestLeftForUser = Math.max(0, Number(env.IMPORT_BEST_DAILY_PER_USER) - used.results[0].n);
  const bestAvailable = bestLeftToday > 0 && bestLeftForUser > 0;
  return {
    models: {
      bestAvailable,
      bestLeftToday,
      bestLeftForUser,
      // Both limits are daily, so the best model is back at the reset.
      bestAvailableAt: bestAvailable ? null : resetsAt,
      resetsAt,
    },
    importModelOpen: importModels(env).some((model) => callsOf(model) < dailyLimit(env, model)),
  };
}

// Why an import can't start now, or null when it can: only every model it could use being
// out for the day stops a start. Nobody is asked anything: the models are tried in order.
export function startRefusal(state, { bestChosen = false } = {}) {
  return state.importModelOpen || (bestChosen && state.models.bestAvailable) ? null : 'quota';
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
    .bind(day, job.id, job.attempt, job.user_id, Number(env.IMPORT_BEST_DAILY_PER_USER))
    .first();
  return row !== null;
}

// Reserves and sends one request to one model. Returns { output }, or { out: true, sent }
// when the model is out for the day; `sent` says whether a request went out before that
// was known. Throws ModelBusyError when the model can't answer right now (a 503, or a
// short rate limit), so the caller moves on to the next model. Nothing waits here.
async function callUnlessOut({ env, llm, model, request }) {
  const limit = dailyLimit(env, model);
  const day = quotaDay(Date.now());
  if (!(limit > 0) || !(await reserveCall(env, model, limit, day))) return { out: true, sent: false };
  try {
    return { output: await llm({ env, model, ...request }) };
  } catch (error) {
    // Google says a 503 is unrelated to quota, so its request is given back to the shared
    // count. If Google counted it after all, its per-day 429 sets the count right.
    if (error instanceof ModelBusyError) await releaseCall(env, model, day);
    if (!(error instanceof QuotaError)) throw error;
    if (error.daily) {
      await markModelOutForTheDay(env, model, limit, Date.now());
      return { out: true, sent: true };
    }
    // A short limit (per minute) passes by itself, like a busy model. Nothing is
    // remembered; the next request simply tries.
    await releaseCall(env, model, day);
    throw new ModelBusyError(`${model} reached a short rate limit`);
  }
}

async function giveBackBestUse(env, job) {
  await env.DB.prepare(`UPDATE llm_requests SET used_best = 0 WHERE id = ? AND status = 'running' AND attempt = ?`)
    .bind(job.id, job.attempt)
    .run();
  job.used_best = 0;
}

// Calls the best model for this row, taking one of the user's daily uses first. The use
// stays taken once a request reached Google, even if the model was busy and another model
// ends up answering: trying the best model is what the 5 count. Only when nothing was sent
// (the shared limit was already reached) is it given back.
async function callBest(job, deps, request) {
  const { env, llm } = deps;
  const day = quotaDay(Date.now());
  const alreadyCounted = holdsBestUse(job, day);
  if (!alreadyCounted) {
    if (!(await claimBestUse(env, job, day))) return { out: true };
    job.used_best = 1;
    job.quota_day = day;
  }
  const result = await callUnlessOut({ env, llm, model: env.LLM_BEST_MODEL, request });
  if (result.out && !result.sent && !alreadyCounted) await giveBackBestUse(env, job);
  return result;
}

// The fallback model, from another provider, for when every model in a list is busy or
// out. It reads text only, so a request with a video never reaches it, and it is off until
// its key is set (GROQ_API_KEY). Returns null when it can't answer either.
async function callFallback({ env, fallbackLlm = callFallbackModel }, request) {
  const model = env.LLM_FALLBACK_MODEL;
  if (!model || !env.GROQ_API_KEY || request.videoUrl) return null;
  try {
    const fallback = await callUnlessOut({ env, llm: fallbackLlm, model, request });
    return fallback.out ? null : { output: fallback.output, model };
  } catch (error) {
    if (error instanceof ModelBusyError) return null;
    throw error;
  }
}

// Tries `models` in order, moving on at once from one that is busy or out for the day,
// then the fallback model. Returns { output, model }. When nothing answers, a busy model
// is reported as busy (it may answer in a minute) and otherwise it is quota.
async function callInOrder(deps, models, request) {
  const { env, llm } = deps;
  let busy = null;
  for (const model of models) {
    try {
      const result = await callUnlessOut({ env, llm, model, request });
      if (!result.out) return { output: result.output, model };
    } catch (error) {
      if (!(error instanceof ModelBusyError)) throw error;
      busy ??= error;
    }
  }
  const fallback = await callFallback(deps, request);
  if (fallback) return fallback;
  throw busy ?? new ImportError('quota');
}

// Sends an import's `request` ({ prompt, schema, videoUrl, videoType }). When the user
// asked for the best model it is tried first, once; if it is busy, out, or the user has
// used their 5, the import goes on by itself. Then the import models are tried in order
// (LLM_IMPORT_MODELS), then the fallback model. Returns { output, model }. Throws
// ImportError quota when every model is out, and ModelBusyError when one was only busy,
// for the Workflow to wait and try again. `deps.llm` and `deps.fallbackLlm` are swapped in tests.
export async function callChosenModel(job, deps, request) {
  if (job.state?.bestChosen) {
    try {
      const best = await callBest(job, deps, request);
      if (!best.out) return { output: best.output, model: deps.env.LLM_BEST_MODEL };
    } catch (error) {
      if (!(error instanceof ModelBusyError)) throw error;
    }
  }
  return callInOrder(deps, importModels(deps.env), request);
}

// A translation's request: text only, so it goes to the small models (LLM_TRANSLATE_MODELS)
// and then the fallback model, leaving the stronger models' few requests for videos.
// Returns { output, model }. Throws ImportError quota when no model can run, and
// ModelBusyError when one was only busy (the user waits, so nothing waits here).
export function callTranslationModel(deps, request) {
  return callInOrder(deps, list(deps.env.LLM_TRANSLATE_MODELS), request);
}
