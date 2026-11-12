// Which model an import uses, and the app's own count of what's left. Quota belongs to
// the whole Google project, so all of this is shared between users, apart from each
// user's daily best-model uses and their approval of the basic model.

import { ImportError } from './errors.js';
import { ModelBusyError, QuotaError } from './llm.js';

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

export async function storeApproval(env, userId, now) {
  await env.DB.prepare(
    `INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET approved_until = excluded.approved_until`,
  )
    .bind(userId, nextQuotaReset(now))
    .run();
}

// ---- What's available ----

// The user's daily best-model uses for day ?1 and user ?2: imports on the best model plus
// translations on it. One SQL expression, so every check counts both the same way.
const BEST_USES_OF_USER = `((SELECT COUNT(*) FROM imports WHERE user_id = ?2 AND quota_day = ?1 AND used_best = 1)
  + COALESCE((SELECT uses FROM translation_best_uses WHERE user_id = ?2 AND day = ?1), 0))`;

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
    env.DB.prepare(`SELECT ${BEST_USES_OF_USER} AS n`).bind(day, userId),
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
// `basicChosen` means the user picked the basic model, so only that one matters.
export function startRefusal(state, { countedBest = false, basicChosen = false } = {}) {
  if (basicChosen) return state.basicOpen ? null : 'quota';
  if (state.models.bestAvailable || (countedBest && state.bestOpen)) return null;
  if (!state.basicOpen) return 'quota';
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
      WHERE id = ?3 AND status = 'running' AND attempt = ?4
        AND ${BEST_USES_OF_USER} < ?5
      RETURNING id`,
  )
    .bind(day, job.user_id, job.id, job.attempt, limits(env).bestPerUser)
    .first();
  return row !== null;
}

// Reserves and sends a request, handling Google's quota answers. Returns { output }, or
// { out: true, sent } when the model can't be used; `sent` says whether a request went
// out before that. Quota errors stop here, because Workflow retries would only burn more
// requests. A busy answer (ModelBusyError) is thrown for the Workflow to wait on.
async function callUnlessOut({ env, llm, model, limit, request }) {
  let sent = false;
  for (let tries = 1; ; tries++) {
    if (await isMarkedOut(env, model, Date.now())) return { out: true, sent };
    const day = quotaDay(Date.now());
    if (!(await reserveCall(env, model, limit, day))) return { out: true, sent };
    sent = true;
    try {
      return { output: await llm({ env, model, ...request }) };
    } catch (error) {
      // Google says a 503 is unrelated to quota, so its request is given back. If Google
      // counted it after all, its per-day 429 sets the count right.
      if (error instanceof ModelBusyError) await releaseCall(env, model, day);
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

async function giveBackBestUse(env, job) {
  await env.DB.prepare(`UPDATE imports SET used_best = 0 WHERE id = ? AND status = 'running' AND attempt = ?`)
    .bind(job.id, job.attempt)
    .run();
  job.used_best = 0;
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
  let result;
  try {
    result = await callUnlessOut({ env, llm, model: env.LLM_BEST_MODEL, limit: limits(env).bestDaily, request });
  } catch (error) {
    // A busy answer took nothing from the shared count, so nothing from the user's 5 either.
    if (error instanceof ModelBusyError && !alreadyCounted) await giveBackBestUse(env, job);
    throw error;
  }
  // Nothing reached Google, so this import didn't take one of the user's daily uses.
  if (result.out && !result.sent && !alreadyCounted) await giveBackBestUse(env, job);
  return result;
}

// How many Workflow waits a busy best model gets before the import moves to the basic one.
// Google advises a short retry first, but a busy spell can last hours.
const BEST_BUSY_RETRIES = 1;

// Sends `request` ({ prompt, schema, videoUrl }) to the model policy allows: the best one
// when it can be used, otherwise the basic one if the user approved it or the best one
// stayed busy. Returns { output, model }. Throws ImportError quota or model_approval_needed
// when neither can run, and ModelBusyError for the Workflow to wait and try again.
// `deps.busyWaits` is how many busy waits this stage has had. Scanning an existing
// recipe's video again follows the same rules as a new import.
export async function callChosenModel(job, deps, request) {
  const { env, llm, busyWaits = 0 } = deps;
  // Reaching more waits than that means the best model was busy on its retry too.
  const bestGaveUp = busyWaits > BEST_BUSY_RETRIES;
  if (!job.state?.basicChosen && !bestGaveUp) {
    let best;
    try {
      best = await callBest(job, deps, request);
    } catch (error) {
      if (!(error instanceof ModelBusyError) || busyWaits < BEST_BUSY_RETRIES) throw error;
      // Still busy after its retry: the basic model is used, approved or not.
      best = { busy: true };
    }
    if (!best.out && !best.busy) return { output: best.output, model: env.LLM_BEST_MODEL };
    if (best.out) {
      const state = await readModelState(env, job.user_id);
      if (!state.basicOpen) throw new ImportError('quota');
      if (!state.models.basicApproved) throw new ImportError('model_approval_needed');
    }
  }

  const model = env.LLM_BASIC_MODEL;
  const basic = await callUnlessOut({ env, llm, model, limit: limits(env).basicDaily, request });
  if (basic.out) throw new ImportError('quota');
  return { output: basic.output, model };
}

// One of the user's daily best-model uses for a translation, taken in one statement so
// it can't pass the cap together with an import. False when the user has used all 5.
async function claimTranslationUse(env, userId, day) {
  const row = await env.DB.prepare(
    `INSERT INTO translation_best_uses (user_id, day, uses)
     SELECT ?2, ?1, 1 WHERE ${BEST_USES_OF_USER} < ?3
     ON CONFLICT (user_id, day) DO UPDATE SET uses = uses + 1
     RETURNING uses`,
  )
    .bind(day, userId, limits(env).bestPerUser)
    .first();
  return row !== null;
}

async function giveBackTranslationUse(env, userId, day) {
  await env.DB.prepare('UPDATE translation_best_uses SET uses = uses - 1 WHERE user_id = ? AND day = ? AND uses > 0')
    .bind(userId, day)
    .run();
}

// One request to the model the user picked (`choice` is 'best' or 'basic'), outside any
// import, for work the user waits for (translation). It takes from the shared daily count;
// on the best model it also takes one of the user's 5 daily best-model uses, given back,
// like an import's, when the model was busy or nothing reached Google. It needs no
// approval and never switches model. Returns the output. Throws ImportError quota when
// that model is out or the user has used their 5, otherwise what callModel throws.
export async function callPickedModel(env, userId, choice, request, llm) {
  if (choice !== 'best') {
    const result = await callUnlessOut({ env, llm, model: env.LLM_BASIC_MODEL, limit: limits(env).basicDaily, request });
    if (result.out) throw new ImportError('quota');
    return result.output;
  }

  const day = quotaDay(Date.now());
  if (!(await claimTranslationUse(env, userId, day))) throw new ImportError('quota');
  let result;
  try {
    result = await callUnlessOut({ env, llm, model: env.LLM_BEST_MODEL, limit: limits(env).bestDaily, request });
  } catch (error) {
    if (error instanceof ModelBusyError) await giveBackTranslationUse(env, userId, day);
    throw error;
  }
  if (result.out) {
    if (!result.sent) await giveBackTranslationUse(env, userId, day);
    throw new ImportError('quota');
  }
  return result.output;
}
