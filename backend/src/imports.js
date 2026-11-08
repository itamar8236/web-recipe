// The import endpoints. Everything here is behind the login check and works only on the
// data of the user the session acts for. The work itself happens in import/workflow.js.

import { fail, json, readJson } from './http.js';
import { quotaDay, readModelState, startRefusal, storeApproval } from './import/models.js';
import { readLink } from './import/sources/index.js';

const STUCK_AFTER_MS = 30 * 60 * 1000;

// A Retry can only help with these: the rest depend on the video itself.
const RETRYABLE_ERRORS = new Set(['llm_error', 'bad_result', 'model_approval_needed', 'quota', 'timed_out']);

const REFUSAL_STATUS = { model_approval_needed: 409, quota: 429 };

const isUniqueViolation = (error) => String(error.message).includes('UNIQUE');
const optionalBoolean = (value) => value === undefined || typeof value === 'boolean';

// state is deliberately absent: it holds whole video descriptions and recipes, and
// polling reads this often.
const IMPORT_SELECT = `SELECT i.id, i.status, i.stage, i.source_url, i.title, i.error, i.recipe_id, r.name_en, r.name_he
  FROM imports i LEFT JOIN recipes r ON r.id = i.recipe_id`;

function toImport(row) {
  const failed = row.status === 'failed';
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    link: row.source_url,
    title: row.title,
    // A running import may hold an error from a try that is about to be repeated.
    error: failed ? row.error : null,
    retryable: failed && RETRYABLE_ERRORS.has(row.error),
    recipeId: row.recipe_id,
    recipeName: row.recipe_id === null ? null : { en: row.name_en, he: row.name_he },
  };
}

const loadImport = (env, userId, id) =>
  env.DB.prepare(`${IMPORT_SELECT} WHERE i.id = ? AND i.user_id = ?`).bind(id, userId).first();

const findRunning = (env, userId, link) =>
  env.DB.prepare(`${IMPORT_SELECT} WHERE i.user_id = ? AND i.platform = ? AND i.source_id = ? AND i.status = 'running'`)
    .bind(userId, link.source.platform, link.sourceId)
    .first();

async function hasRecipeFor(env, userId, sourceUrl) {
  const row = await env.DB.prepare('SELECT 1 FROM recipes WHERE user_id = ? AND source_url = ?').bind(userId, sourceUrl).first();
  return row !== null;
}

// Starts the background work and answers with the card. If it can't start, the user gets
// a failed card with Retry, rather than one that says "running" for 30 minutes.
async function startAndRespond(env, userId, id, attempt) {
  try {
    await env.IMPORT_WORKFLOW.create({ id: `import-${id}-${attempt}`, params: { importId: id, attempt } });
  } catch (error) {
    console.error(error);
    await env.DB.prepare(`UPDATE imports SET status = 'failed', error = 'llm_error', updated_at = ? WHERE id = ? AND status = 'running' AND attempt = ?`)
      .bind(Date.now(), id, attempt)
      .run();
  }
  return json({ import: toImport(await loadImport(env, userId, id)) }, 202);
}

// ---- Starting ----

// Both caps, as one SQL condition: checked first so the answer comes before the model
// checks, and again inside the INSERT so two requests at once can't both take the last slot.
const UNDER_CAPS = `(SELECT COUNT(*) FROM imports WHERE user_id = ?1 AND quota_day = ?2) < ?3
  AND (SELECT COUNT(*) FROM imports WHERE user_id = ?1 AND quota_day = ?2 AND status = 'running') < ?4`;

const capValues = (env, userId, day) => [userId, day, Number(env.IMPORT_DAILY_LIMIT), Number(env.IMPORT_MAX_RUNNING)];

async function isUnderCaps(env, userId, day) {
  const row = await env.DB.prepare(`SELECT ${UNDER_CAPS} AS ok`).bind(...capValues(env, userId, day)).first();
  return row.ok === 1;
}

async function createImport(request, env, userId) {
  const body = await readJson(request);
  if (typeof body?.url !== 'string' || !optionalBoolean(body.useBasicModel)) return fail(400, 'invalid_request');

  const link = readLink(body.url);
  if (link.error) return fail(400, link.error);

  const running = await findRunning(env, userId, link);
  if (running) return json({ import: toImport(running) });
  if (await hasRecipeFor(env, userId, link.sourceUrl)) return fail(409, 'already_imported');

  const now = Date.now();
  const day = quotaDay(now);
  if (!(await isUnderCaps(env, userId, day))) return fail(429, 'too_many_imports');

  if (body.useBasicModel) await storeApproval(env, userId, now);
  const refusal = startRefusal(await readModelState(env, userId, now));
  if (refusal) return fail(REFUSAL_STATUS[refusal], refusal);

  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO imports (user_id, platform, source_id, source_url, quota_day, created_at, updated_at)
       SELECT ?1, ?5, ?6, ?7, ?2, ?8, ?8 WHERE ${UNDER_CAPS}
       RETURNING id, attempt`,
    )
      .bind(...capValues(env, userId, day), link.source.platform, link.sourceId, link.sourceUrl, now)
      .first();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another tap or device started the same video a moment ago.
    return json({ import: toImport(await findRunning(env, userId, link)) });
  }
  if (!row) return fail(429, 'too_many_imports');
  return startAndRespond(env, userId, row.id, row.attempt);
}

// ---- Listing ----

async function listImports(env, userId) {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE imports SET status = 'failed', error = 'timed_out', updated_at = ?
      WHERE user_id = ? AND status = 'running' AND updated_at < ?`,
  )
    .bind(now, userId, now - STUCK_AFTER_MS)
    .run();

  const [{ results }, state] = await Promise.all([
    env.DB.prepare(`${IMPORT_SELECT} WHERE i.user_id = ? AND i.status IN ('running', 'failed', 'done') ORDER BY i.id DESC`)
      .bind(userId)
      .all(),
    readModelState(env, userId, now),
  ]);
  return json({ imports: results.map(toImport), models: state.models });
}

// ---- Retrying and dismissing ----

// A retry would be pointless, or make a duplicate, if the recipe already exists now or
// the recipe a re-run was going to replace is gone.
async function isStillWanted(env, userId, row) {
  if (row.replace_recipe_id === null) return !(await hasRecipeFor(env, userId, row.source_url));
  const recipe = await env.DB.prepare('SELECT 1 FROM recipes WHERE id = ? AND user_id = ?').bind(row.replace_recipe_id, userId).first();
  return recipe !== null;
}

// A failed save has its recipe already, so it needs no model at all.
async function retryRefusal(env, userId, body, row, now) {
  if (row.extracted_model !== null) return null;
  const bestOnly = row.replace_recipe_id !== null;
  if (body.useBasicModel && !bestOnly) await storeApproval(env, userId, now);
  const countedBest = row.used_best === 1 && row.quota_day === quotaDay(now);
  return startRefusal(await readModelState(env, userId, now), { bestOnly, countedBest });
}

async function retryImport(request, env, userId, id) {
  const body = await readJson(request);
  if (!body || !optionalBoolean(body.useBasicModel)) return fail(400, 'invalid_request');

  const row = await env.DB.prepare(
    `SELECT status, error, source_url, replace_recipe_id, used_best, quota_day,
            json_extract(state, '$.model') AS extracted_model
       FROM imports WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first();
  if (!row) return fail(404, 'not_found');
  if (row.status !== 'failed' || !RETRYABLE_ERRORS.has(row.error)) return fail(409, 'not_retryable');
  if (!(await isStillWanted(env, userId, row))) return fail(409, 'not_retryable');

  const now = Date.now();
  const refusal = await retryRefusal(env, userId, body, row, now);
  if (refusal) return fail(REFUSAL_STATUS[refusal], refusal);

  // One statement, so a double tap restarts it only once. On a later day it counts as
  // that day's import, and any best-model use from the earlier day no longer applies.
  let restarted;
  try {
    restarted = await env.DB.prepare(
      `UPDATE imports SET status = 'running', attempt = attempt + 1, error = NULL, updated_at = ?1,
         used_best = CASE WHEN quota_day = ?2 THEN used_best ELSE 0 END, quota_day = ?2
       WHERE id = ?3 AND user_id = ?4 AND status = 'failed'
       RETURNING attempt`,
    )
      .bind(now, quotaDay(now), id, userId)
      .first();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return fail(409, 'not_retryable');
  }
  if (!restarted) return fail(409, 'not_retryable');
  return startAndRespond(env, userId, id, restarted.attempt);
}

async function dismissImport(env, userId, id) {
  const row = await env.DB.prepare(`UPDATE imports SET status = 'dismissed', updated_at = ? WHERE id = ? AND user_id = ? RETURNING id`)
    .bind(Date.now(), id, userId)
    .first();
  return row ? json({ ok: true }) : fail(404, 'not_found');
}

// ---- Re-running a basic-model recipe ----

async function rerunRecipe(request, env, userId, recipeId) {
  if (!(await readJson(request))) return fail(400, 'invalid_request');

  const recipe = await env.DB.prepare('SELECT source_url, source_model FROM recipes WHERE id = ? AND user_id = ?')
    .bind(recipeId, userId)
    .first();
  if (!recipe) return fail(404, 'not_found');
  if (recipe.source_model !== env.LLM_BASIC_MODEL) return fail(409, 'not_rerunnable');
  const link = readLink(recipe.source_url);
  if (link.error) return fail(409, 'not_rerunnable');

  const now = Date.now();
  const { models } = await readModelState(env, userId, now);
  if (!models.bestAvailable) return fail(429, 'best_model_unavailable');

  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO imports (user_id, platform, source_id, source_url, replace_recipe_id, quota_day, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, attempt`,
    )
      .bind(userId, link.source.platform, link.sourceId, link.sourceUrl, recipeId, quotaDay(now), now, now)
      .first();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return fail(409, 'not_rerunnable');
  }
  return startAndRespond(env, userId, row.id, row.attempt);
}

// Routes /api/imports[/:id[/retry]] and /api/recipes/:id/rerun. Returns null for any
// other path.
export function handleImports(request, env, path, userId) {
  const method = request.method;
  const rerun = path.match(/^\/api\/recipes\/(\d+)\/rerun$/);
  if (rerun) return method === 'POST' ? rerunRecipe(request, env, userId, Number(rerun[1])) : fail(405, 'method_not_allowed');

  const match = path.match(/^\/api\/imports(?:\/(\d+)(\/retry)?)?$/);
  if (!match) return null;
  const id = match[1] === undefined ? null : Number(match[1]);
  if (id === null && method === 'GET') return listImports(env, userId);
  if (id === null && method === 'POST') return createImport(request, env, userId);
  if (id !== null && match[2] && method === 'POST') return retryImport(request, env, userId, id);
  if (id !== null && !match[2] && method === 'DELETE') return dismissImport(env, userId, id);
  return fail(405, 'method_not_allowed');
}
