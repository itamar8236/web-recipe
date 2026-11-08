// Which model an import uses, and the app's own count of what's left. Quota belongs to
// the whole Google project, so all of this is shared between users, apart from each
// user's daily best-model uses and their approval of the basic model.

import { ImportError } from './errors.js';
import { QuotaError } from './llm.js';

const COOL_DOWN_MS = 15 * 60 * 1000;

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

// ---- Counting and marking ----

// Takes one request from the day's count, in one statement, so two imports can't both
// take the last one. False means the limit is reached and no request may be sent.
export async function reserveCall(env, model, limit) {
  const row = await env.DB.prepare(
    `INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, 1)
     ON CONFLICT (day, model) DO UPDATE SET calls = calls + 1 WHERE calls < ?
     RETURNING calls`,
  )
    .bind(quotaDay(Date.now()), model, limit)
    .first();
  return row !== null;
}

const markOutStatement = (env, model, until) =>
  env.DB.prepare(
    `INSERT INTO llm_model_status (model, unavailable_until) VALUES (?, ?)
     ON CONFLICT (model) DO UPDATE SET unavailable_until = max(unavailable_until, excluded.unavailable_until)`,
  ).bind(model, until);

async function markModelOutForTheDay(env, model, limit, now) {
  await env.DB.batch([
    markOutStatement(env, model, nextQuotaReset(now)),
    // Google is the source of truth, and it may have counted requests the app didn't make.
    env.DB.prepare(
      `INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?)
       ON CONFLICT (day, model) DO UPDATE SET calls = excluded.calls`,
    ).bind(quotaDay(now), model, limit),
  ]);
}

async function isMarkedOut(env, model, now) {
  const row = await env.DB.prepare('SELECT 1 FROM llm_model_status WHERE model = ? AND unavailable_until > ?')
    .bind(model, now)
    .first();
  return row !== null;
}

// ---- Approvals ----

export async function storeApproval(env, userId, now = Date.now()) {
  await env.DB.prepare(
    `INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET approved_until = excluded.approved_until`,
  )
    .bind(userId, nextQuotaReset(now))
    .run();
}

// ---- What's available ----

// The `models` object the API returns, plus whether each model itself is open: the
// frontend needs only the first, the checks before starting need both.
export async function readModelState(env, userId, now = Date.now()) {
  const best = env.LLM_BEST_MODEL;
  const basic = env.LLM_BASIC_MODEL;
  const limit = limits(env);
  const day = quotaDay(now);
  const [marked, usage, used, approval] = await env.DB.batch([
    env.DB.prepare('SELECT model, unavailable_until FROM llm_model_status WHERE model IN (?, ?) AND unavailable_until > ?').bind(best, basic, now),
    env.DB.prepare('SELECT model, calls FROM llm_usage WHERE day = ? AND model IN (?, ?)').bind(day, best, basic),
    env.DB.prepare('SELECT COUNT(*) AS n FROM imports WHERE user_id = ? AND quota_day = ? AND used_best = 1').bind(userId, day),
    env.DB.prepare('SELECT 1 FROM llm_basic_model_approvals WHERE user_id = ? AND approved_until > ?').bind(userId, now),
  ]);
  const callsOf = (model) => usage.results.find((row) => row.model === model)?.calls ?? 0;
  const outUntil = (model) => marked.results.find((row) => row.model === model)?.unavailable_until ?? null;

  const resetsAt = nextQuotaReset(now);
  const bestLeftToday = Math.max(0, limit.bestDaily - callsOf(best));
  const bestLeftForUser = Math.max(0, limit.bestPerUser - used.results[0].n);
  const bestOpen = outUntil(best) === null && bestLeftToday > 0;
  const bestAvailable = bestOpen && bestLeftForUser > 0;
  const bestBackOnlyAtReset = bestLeftToday === 0 || bestLeftForUser === 0;
  return {
    models: {
      bestAvailable,
      bestLeftToday,
      bestLeftForUser,
      basicModel: basic,
      basicApproved: approval.results.length > 0,
      bestAvailableAt: bestAvailable ? null : bestBackOnlyAtReset ? resetsAt : outUntil(best),
      resetsAt,
    },
    bestOpen,
    basicOpen: outUntil(basic) === null && callsOf(basic) < limit.basicDaily,
  };
}

// Why an import can't start now, or null when it can. `countedBest` means this import
// already holds one of the user's daily best-model uses, so their cap doesn't stop it.
export function startRefusal(state, { bestOnly = false, countedBest = false } = {}) {
  if (state.models.bestAvailable || (countedBest && state.bestOpen)) return null;
  if (bestOnly || !state.basicOpen) return 'quota';
  return state.models.basicApproved ? null : 'model_approval_needed';
}

// ---- Calling ----

// Whether this import already holds one of the user's daily best-model uses for `day`.
export const holdsBestUse = (job, day) => job.used_best === 1 && job.quota_day === day;

// One of the user's daily best-model uses, taken in one statement so imports running at
// the same time can't go past the cap.
async function claimBestUse(env, job, day) {
  const row = await env.DB.prepare(
    `UPDATE imports SET used_best = 1, quota_day = ?1
      WHERE id = ?2 AND status = 'running' AND attempt = ?3
        AND (SELECT COUNT(*) FROM imports WHERE user_id = ?4 AND quota_day = ?1 AND used_best = 1) < ?5
      RETURNING id`,
  )
    .bind(day, job.id, job.attempt, job.user_id, limits(env).bestPerUser)
    .first();
  return row !== null;
}

// Reserves and sends a request, handling Google's quota answers. Returns { output }, or
// { out: true, sent } when the model can't be used; `sent` says whether a request went
// out before that. Quota errors stop here, because Workflow retries would only burn more
// requests.
async function callUnlessOut({ env, llm, model, limit, request }) {
  let sent = false;
  for (let tries = 1; ; tries++) {
    if (await isMarkedOut(env, model, Date.now())) return { out: true, sent };
    if (!(await reserveCall(env, model, limit))) return { out: true, sent };
    sent = true;
    try {
      return { output: await llm({ env, model, ...request }) };
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      const now = Date.now();
      if (error.daily) {
        await markModelOutForTheDay(env, model, limit, now);
        return { out: true, sent };
      }
      if (tries === 2) {
        await markOutStatement(env, model, now + COOL_DOWN_MS).run();
        return { out: true, sent };
      }
      await sleep(error.retryDelayMs);
    }
  }
}

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
  if (result.out && !result.sent && !alreadyCounted) {
    // Nothing reached Google, so this import didn't take one of the user's daily uses.
    await env.DB.prepare('UPDATE imports SET used_best = 0 WHERE id = ?').bind(job.id).run();
    job.used_best = 0;
  }
  return result;
}

// Sends `request` ({ prompt, schema, videoUrl }) to the model policy allows: the best one
// when it can be used, otherwise the basic one if the user approved it. Returns
// { output, model }. Throws ImportError quota or model_approval_needed when neither can
// run. A re-run never falls back: replacing a recipe with a basic-model answer is what it
// exists to undo.
export async function callChosenModel(job, deps, request) {
  const { env, llm } = deps;
  const best = await callBest(job, deps, request);
  if (!best.out) return { output: best.output, model: env.LLM_BEST_MODEL };
  if (job.replace_recipe_id !== null) throw new ImportError('quota');

  const state = await readModelState(env, job.user_id);
  if (!state.basicOpen) throw new ImportError('quota');
  if (!state.models.basicApproved) throw new ImportError('model_approval_needed');

  const model = env.LLM_BASIC_MODEL;
  const basic = await callUnlessOut({ env, llm, model, limit: limits(env).basicDaily, request });
  if (basic.out) throw new ImportError('quota');
  return { output: basic.output, model };
}
