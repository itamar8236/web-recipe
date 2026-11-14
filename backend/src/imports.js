// The import endpoints. Everything here is behind the login check and works only on the
// data of the user the session acts for. The work itself happens in import/workflow.js.
// Every start, Retry and re-scan is its own imports row (purpose 'import'), so each try
// that calls the best model counts toward the user's 5; translations are rows too, but
// with purpose 'translation' (translate.js), and never show as cards.

import { fail, json, readJson } from './http.js';
import { quotaDay, readModelState, startRefusal } from './import/models.js';
import { readLink } from './import/sources/index.js';
import { markFailed } from './import/stages.js';

const STUCK_AFTER_MS = 30 * 60 * 1000;

// A Retry can only help with these: the rest depend on the video itself.
// model_approval_needed is only on rows from before the basic model stopped needing an
// approval; a Retry now just runs them. A site that blocked the request or asked for a
// login may answer differently later, and trying again costs no model request.
const RETRYABLE_ERRORS = new Set([
  'llm_error',
  'bad_result',
  'model_approval_needed',
  'quota',
  'timed_out',
  'source_blocked',
  'login_required',
]);

const isUniqueViolation = (error) => String(error.message).includes('UNIQUE');

// state is deliberately absent: it holds whole video descriptions and recipes, and
// polling reads this often.
const IMPORT_SELECT = `SELECT i.id, i.status, i.stage, i.source_url, i.title, i.error, i.recipe_id, r.name_en, r.name_he
  FROM llm_requests i LEFT JOIN recipes r ON r.id = i.recipe_id`;

// Only these rows are cards: translations are not imports.
const IS_IMPORT = `i.purpose = 'import'`;

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
  env.DB.prepare(`${IMPORT_SELECT} WHERE ${IS_IMPORT} AND i.user_id = ? AND i.platform = ? AND i.source_id = ? AND i.status = 'running'`)
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
    await markFailed(env, id, attempt);
  }
  return json({ import: toImport(await loadImport(env, userId, id)) }, 202);
}

// ---- Starting ----

// Both caps, as one SQL condition: checked first so the answer comes before the model
// checks, and again inside the INSERT so two requests at once can't both take the last slot.
// Every try counts (a Retry is a row too); translations don't.
const UNDER_CAPS = `(SELECT COUNT(*) FROM llm_requests WHERE user_id = ?1 AND quota_day = ?2 AND purpose = 'import') < ?3
  AND (SELECT COUNT(*) FROM llm_requests WHERE user_id = ?1 AND quota_day = ?2 AND purpose = 'import' AND status = 'running') < ?4`;

const capValues = (env, userId, day) => [userId, day, Number(env.IMPORT_DAILY_LIMIT), Number(env.IMPORT_MAX_RUNNING)];

async function isUnderCaps(env, userId, day) {
  const row = await env.DB.prepare(`SELECT ${UNDER_CAPS} AS ok`).bind(...capValues(env, userId, day)).first();
  return row.ok === 1;
}

// Reads the model choice every start takes: `model` is 'best' (default) or 'basic'. Null
// when invalid. With 'best', the basic model still answers by itself when the best one
// can't be used; with 'basic', the best one is never tried.
function readModelChoice(body) {
  const validModel = body?.model === undefined || body.model === 'best' || body.model === 'basic';
  if (!body || !validModel) return null;
  return { basicChosen: body.model === 'basic' };
}

// Checks the caps and the model, then inserts the row and starts it. `replaceRecipeId` is
// set when an existing recipe's video is scanned again. Returns null when the same video
// started a moment ago (another tap or device), for the caller to answer.
async function startNew(env, userId, link, { basicChosen }, replaceRecipeId = null) {
  const now = Date.now();
  const day = quotaDay(now);
  if (!(await isUnderCaps(env, userId, day))) return fail(429, 'too_many_imports');

  const refusal = startRefusal(await readModelState(env, userId, now), { basicChosen });
  if (refusal) return fail(429, refusal);

  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO llm_requests (user_id, platform, source_id, source_url, state, replace_recipe_id, quota_day, created_at, updated_at)
       SELECT ?1, ?5, ?6, ?7, ?9, ?10, ?2, ?8, ?8 WHERE ${UNDER_CAPS}
       RETURNING id, attempt`,
    )
      .bind(
        ...capValues(env, userId, day),
        link.source.platform,
        link.sourceId,
        link.sourceUrl,
        now,
        JSON.stringify(basicChosen ? { basicChosen: true } : {}),
        replaceRecipeId,
      )
      .first();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
  if (!row) return fail(429, 'too_many_imports');
  return startAndRespond(env, userId, row.id, row.attempt);
}

async function createImport(request, env, userId) {
  const body = await readJson(request);
  const choice = readModelChoice(body);
  if (typeof body?.url !== 'string' || !choice) return fail(400, 'invalid_request');

  const link = readLink(body.url);
  if (link.error) return fail(400, link.error);

  const running = await findRunning(env, userId, link);
  if (running) return json({ import: toImport(running) });
  if (await hasRecipeFor(env, userId, link.sourceUrl)) return fail(409, 'already_imported');

  const response = await startNew(env, userId, link, choice);
  if (response) return response;
  // If the other start has already finished by now, there is a recipe for this video.
  const other = await findRunning(env, userId, link);
  return other ? json({ import: toImport(other) }) : fail(409, 'already_imported');
}

// ---- Listing ----

async function listImports(env, userId) {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE llm_requests SET status = 'failed', error = 'timed_out', updated_at = ?
      WHERE user_id = ? AND status = 'running' AND updated_at < ?`,
  )
    .bind(now, userId, now - STUCK_AFTER_MS)
    .run();

  const [{ results }, state] = await Promise.all([
    env.DB.prepare(`${IMPORT_SELECT} WHERE ${IS_IMPORT} AND i.user_id = ? AND i.status IN ('running', 'failed', 'done') ORDER BY i.id DESC`)
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
async function retryRefusal(env, userId, row, now) {
  if (row.extracted_model !== null) return null;
  return startRefusal(await readModelState(env, userId, now), { basicChosen: row.basic_chosen === 1 });
}

// A Retry is a new row, and the failed card goes away. Being a new row, it counts toward
// the caps and, if it calls the best model, toward the user's 5, like any other try.
// It starts over from the first stage, keeping only the model choice: what the earlier
// stages left (a site's signed video link, an uploaded video file) expires, and getting it
// again costs no model request. Only a failed save keeps its state, because it holds the
// recipe the model already wrote.
const RETRY_STAGE = `CASE WHEN json_extract(state, '$.model') IS NOT NULL THEN stage ELSE 'meta' END`;
const RETRY_STATE = `CASE WHEN json_extract(state, '$.model') IS NOT NULL THEN state
  WHEN json_extract(state, '$.basicChosen') THEN '{"basicChosen":true}' ELSE '{}' END`;

async function retryImport(request, env, userId, id) {
  if (!(await readJson(request))) return fail(400, 'invalid_request');

  const row = await env.DB.prepare(
    `SELECT status, error, source_url, replace_recipe_id,
            json_extract(state, '$.model') AS extracted_model,
            json_extract(state, '$.basicChosen') AS basic_chosen
       FROM llm_requests WHERE id = ? AND user_id = ? AND purpose = 'import'`,
  )
    .bind(id, userId)
    .first();
  if (!row) return fail(404, 'not_found');
  if (row.status !== 'failed' || !RETRYABLE_ERRORS.has(row.error)) return fail(409, 'not_retryable');
  if (!(await isStillWanted(env, userId, row))) return fail(409, 'not_retryable');

  const now = Date.now();
  const day = quotaDay(now);
  if (!(await isUnderCaps(env, userId, day))) return fail(429, 'too_many_imports');
  const refusal = await retryRefusal(env, userId, row, now);
  if (refusal) return fail(429, refusal);

  // A double tap or a second device makes a second running row for the same video, which
  // the unique index refuses.
  let added;
  try {
    added = await env.DB.prepare(
      `INSERT INTO llm_requests (user_id, platform, source_id, source_url, title, stage, state, replace_recipe_id, quota_day, created_at, updated_at)
       SELECT user_id, platform, source_id, source_url, title, ${RETRY_STAGE}, ${RETRY_STATE}, replace_recipe_id, ?2, ?5, ?5
         FROM llm_requests WHERE id = ?6 AND status = 'failed' AND ${UNDER_CAPS}
       RETURNING id, attempt`,
    )
      .bind(...capValues(env, userId, day), now, id)
      .first();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return fail(409, 'not_retryable');
  }
  if (!added) return fail(409, 'not_retryable');
  await env.DB.prepare(`UPDATE llm_requests SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'failed'`).bind(now, id).run();
  return startAndRespond(env, userId, added.id, added.attempt);
}

async function dismissImport(env, userId, id) {
  const row = await env.DB.prepare(`UPDATE llm_requests SET status = 'dismissed', updated_at = ? WHERE id = ? AND user_id = ? AND purpose = 'import' RETURNING id`)
    .bind(Date.now(), id, userId)
    .first();
  return row ? json({ ok: true }) : fail(404, 'not_found');
}

// ---- Scanning a recipe's video again ----

// Any recipe with a link can be scanned again, on the model the user picks, exactly like a
// new import. When it finishes it replaces the recipe's text.
async function rerunRecipe(request, env, userId, recipeId) {
  const choice = readModelChoice(await readJson(request));
  if (!choice) return fail(400, 'invalid_request');

  const recipe = await env.DB.prepare('SELECT source_url FROM recipes WHERE id = ? AND user_id = ?')
    .bind(recipeId, userId)
    .first();
  if (!recipe) return fail(404, 'not_found');
  const link = recipe.source_url === null ? { error: 'manual' } : readLink(recipe.source_url);
  if (link.error) return fail(409, 'not_rerunnable');
  if (await findRunning(env, userId, link)) return fail(409, 'not_rerunnable');

  return (await startNew(env, userId, link, choice, recipeId)) ?? fail(409, 'not_rerunnable');
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
