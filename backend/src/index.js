import { handleBrowse } from './browse.js';
import { handleData } from './data.js';
import { handleDeleted, purgeDeleted } from './deleted.js';
import { handleImports } from './imports.js';
import { handleNutrition } from './nutrition.js';
import { handlePictures } from './pictures.js';
import { handleSubstitute } from './substitute.js';
import { handleTranslate } from './translate.js';
import { fail, json, readJson } from './http.js';
import { hashPassword, verifyPassword } from './password.js';
import { actAs, endSession, getSessionUser, startSession } from './session.js';

export { ImportWorkflow } from './import/workflow.js';

const MAX_USERS = 50;
const MIN_PASSWORD = 1;
const MAX_PASSWORD = 200;

const usernameValid = (username) => username.length >= 1 && username.length <= 50;
const passwordValid = (password) => password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;

// defaultPublic and copyTags are the user's own defaults (see schema.sql).
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    is_admin: user.is_admin === 1,
    defaultPublic: user.default_public === 1,
    copyTags: user.copy_tags === 1,
  };
}

const USER_COLUMNS = 'id, username, is_admin, default_public, copy_tags';

// Reads { username, password } from the body. Returns null if it isn't a JSON object of
// strings (readJson also refuses a body another site's plain HTML form could send, so no
// other site can sign a visitor up or log them in to an account it chose).
async function readCredentials(request) {
  const body = await readJson(request);
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string') return null;
  return { username: body.username.trim(), password: body.password };
}

// Compared against when the username does not exist, so a missing user takes as long to
// reject as a wrong password and the response time does not reveal which usernames exist.
let dummyHash;

async function login(request, env) {
  const credentials = await readCredentials(request);
  if (!credentials) return fail(400, 'invalid_request');

  const user = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`,
  )
    .bind(credentials.username)
    .first();
  // No stored password is longer than MAX_PASSWORD (sign-up refuses it), and refusing
  // instead of hashing keeps a huge password from tying up the Worker.
  if (credentials.password.length > MAX_PASSWORD) return fail(401, 'invalid_credentials');
  dummyHash ??= await hashPassword('dummy');
  const ok = await verifyPassword(credentials.password, user ? user.password_hash : dummyHash);
  if (!user || !ok) return fail(401, 'invalid_credentials');

  return json({ user: publicUser(user) }, 200, await startSession(request, env, user.id));
}

async function register(request, env) {
  const credentials = await readCredentials(request);
  if (!credentials) return fail(400, 'invalid_request');
  const { username, password } = credentials;
  if (!usernameValid(username)) return fail(400, 'username_invalid');
  if (!passwordValid(password)) return fail(400, 'password_invalid');

  // The cap is part of the INSERT so two sign-ups at once cannot both take the last slot.
  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, created_at)
       SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM users) < ?
       RETURNING ${USER_COLUMNS}`,
    )
      .bind(username, await hashPassword(password), Date.now(), MAX_USERS)
      .first();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return fail(409, 'username_taken');
    throw error;
  }
  if (!row) return fail(403, 'user_limit');

  return json({ user: publicUser(row) }, 201, await startSession(request, env, row.id));
}

// Changes the logged-in user's own username, password and/or defaults. The old password is not
// asked for, and every existing login stays (the owner chose both): the session already
// proves who this is, and the new details are only needed for the next login. While the
// admin acts as another user, this changes that user, as if they had done it themselves.
async function updateMe(request, env, user) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid_request');
  const { username, password, defaultPublic, copyTags } = body;
  if ([username, password, defaultPublic, copyTags].every((value) => value === undefined)) {
    return fail(400, 'invalid_request');
  }
  for (const flag of [defaultPublic, copyTags]) {
    if (flag !== undefined && typeof flag !== 'boolean') return fail(400, 'invalid_request');
  }
  const flagValue = (flag) => (flag === undefined ? null : Number(flag));
  if (username !== undefined && typeof username !== 'string') return fail(400, 'invalid_request');
  if (password !== undefined && typeof password !== 'string') return fail(400, 'invalid_request');
  const newName = username?.trim();
  if (newName !== undefined && !usernameValid(newName)) return fail(400, 'username_invalid');
  if (password !== undefined && !passwordValid(password)) return fail(400, 'password_invalid');

  let row;
  try {
    row = await env.DB.prepare(
      `UPDATE users SET username = COALESCE(?, username), password_hash = COALESCE(?, password_hash),
              default_public = COALESCE(?, default_public), copy_tags = COALESCE(?, copy_tags)
        WHERE id = ? RETURNING ${USER_COLUMNS}`,
    )
      .bind(
        newName ?? null,
        password === undefined ? null : await hashPassword(password),
        flagValue(defaultPublic),
        flagValue(copyTags),
        user.id,
      )
      .first();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return fail(409, 'username_taken');
    throw error;
  }
  return json({ user: publicUser(row) });
}

// Admin only: the usernames the admin can log in as (everyone but the admin), A to Z.
// usernames are unique (NOCASE), so no two look the same.
async function listUsers(env, user) {
  if (user.is_admin !== 1) return fail(403, 'not_admin');
  const { results } = await env.DB.prepare(
    'SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username COLLATE NOCASE',
  ).all();
  return json({ users: results });
}

// Admin only: from now on this device is logged in as that user, with no password, for
// everything, until it logs out (logging in again as the admin starts a clean session).
// While acting as someone, `user` is that user, who is never the admin, so an admin can't
// hop from one user to the next without logging out first.
async function impersonate(request, env, user) {
  if (user.is_admin !== 1) return fail(403, 'not_admin');
  const body = await readJson(request);
  if (!Number.isInteger(body?.userId)) return fail(400, 'invalid_request');
  const target = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND is_admin = 0`)
    .bind(body.userId)
    .first();
  if (!target) return fail(404, 'not_found');
  await actAs(request, env, target.id);
  return json({ user: publicUser(target) });
}

async function logout(request, env) {
  return json({ ok: true }, 200, await endSession(request, env));
}

async function handleApi(request, env, path) {
  const method = request.method;

  // Public: the only endpoints that work without a session.
  if (method === 'POST' && path === '/api/auth/login') return login(request, env);
  if (method === 'POST' && path === '/api/auth/register') return register(request, env);
  if (method === 'POST' && path === '/api/auth/logout') return logout(request, env);

  const user = await getSessionUser(request, env);
  if (!user) return fail(401, 'not_logged_in');

  if (method === 'GET' && path === '/api/auth/me') return json({ user: publicUser(user) });
  if (method === 'PUT' && path === '/api/auth/me') return updateMe(request, env, user);
  if (method === 'GET' && path === '/api/admin/users') return listUsers(env, user);
  if (method === 'POST' && path === '/api/admin/impersonate') return impersonate(request, env, user);

  return (
    handlePictures(request, env, path, user.id) ??
    handleImports(request, env, path, user.id) ??
    handleTranslate(request, env, path, user.id) ??
    handleNutrition(request, env, path, user.id) ??
    handleSubstitute(request, env, path, user.id) ??
    handleData(request, env, path, user.id) ??
    handleDeleted(request, env, path, user.id) ??
    handleBrowse(request, env, path, user.id) ??
    fail(404, 'not_found')
  );
}

export default {
  async fetch(request, env) {
    try {
      return await handleApi(request, env, new URL(request.url).pathname);
    } catch (error) {
      console.error(error);
      return fail(500, 'server_error');
    }
  },

  // The daily cron job (triggers.crons in wrangler.jsonc).
  async scheduled(controller, env) {
    await purgeDeleted(env);
  },
};
